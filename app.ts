import * as dotenv from 'dotenv';
import axios from 'axios';
import { Octokit } from '@octokit/rest';
import * as fs from 'fs';
import * as csv from 'fast-csv';
import { marked } from 'marked';
import { VoyageAIClient } from "voyageai";

// Load environment variables
dotenv.config();

// Authenticate using GitHub Token
const auth = process.env.GITHUB_TOKEN;
const octokit = new Octokit({ auth });
const vo = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY });

// GraphQL API endpoint
const url = 'https://api.github.com/graphql';
const headers = { Authorization: `token ${auth}` };

function removeSpecificWords(text: string): string {
    const words = ["/start", '/stop', 
        '- Be sure to open a draft pull request as soon as possible to communicate updates on your progress.',
        '- Be sure to provide timely updates to us when requested, or you will be automatically unassigned from the task.'];
    return words.some(word => text.includes(word)) ? "" : text;
}

function cleanText(text: string): string {
    if (!text) return "";
    // Remove non-printable characters
    text = text.replace(/[^\x20-\x7E\s]/g, '');
    // Escape double quotes by doubling them (CSV standard)
    text = text.replace(/"/g, '""');
    return text;
}

async function cleanMarkdown(text: string): Promise<string> {
    if (!text) return "";
    const html = await marked(text);
    return html.replace(/<[^>]+>/g, '');
}

function formatEmbedding(embedding: number[]): string {
    return `[${embedding.join(', ')}]`;
}

async function extractEmbeddings(text: string): Promise<number[]> {
    const response = await vo.embed({
        input: text,
        model: "voyage-large-2-instruct",
      });
      return (response.data && response.data[0]?.embedding) || [];
}

async function fetchAuthorId(userLogin: string): Promise<number | null> {
    try {
        const response = await axios.get(`https://api.github.com/users/${userLogin}`, { headers });
        return response.data.id;
    } catch (error) {
        console.error(`Error fetching author ID for ${userLogin}:`, error);
        return -1;
    }
}

function getCurrentTimestamp(): string {
    return new Date().toISOString();
}

function fetchPayloadIssue(issueNumber: number, orgName: string, repoName: string): any {
    return octokit.issues.get({
        owner: orgName,
        repo: repoName,
        issue_number: issueNumber
    });
}

async function fetchPayloadPR(prNumber: number, orgName: string, repoName: string): Promise<any> {
    return (await octokit.pulls.get({
        owner: orgName,
        repo: repoName,
        pull_number: prNumber
    })).data;
}

async function fetchPayloadPRRC(commentId: number, orgName: string, repoName: string): Promise<any> {
    return (await octokit.pulls.getReviewComment(
        {
            owner: orgName,
            repo: repoName,
            comment_id: commentId
        }
    )).data;
}

async function fetchPayloadPRThread(pull_number: number, review_id: number, orgName: string, repoName: string): Promise<any> {
    return (await octokit.pulls.getReview(
        {
            owner: orgName,
            repo: repoName,
            pull_number: pull_number,
            review_id: review_id
        }
    )).data;
}

async function fetchPayloadComment(commentId: number, orgName: string, repoName: string): Promise<any> {
    return (await octokit.issues.getComment({
        owner: orgName,
        repo: repoName,
        comment_id: commentId
    })).data;
}


async function fetchPrDataGraphql(prNodeId: string): Promise<any> {
    const query = `
    query ($pullRequestId: ID!) {
      node(id: $pullRequestId) {
        ... on PullRequest {
          title
          id
          body
          author {
            login
          }
          comments(first: 100) {
            nodes {
              body
              id
              author {
                login
              }
            }
          }
          reviewThreads(first: 100){
            nodes {
              comments(first: 100){
                nodes {
                  body
                  id
                  author {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }
    `;
    const variables = { pullRequestId: prNodeId };
    const response = await axios.post(url, { query, variables }, { headers });
    return response.data.data.node;
}

class Issue {
    userLogin: string;
    [key: string]: any;

    constructor(issueData: any) {
        this.userLogin = issueData.user.login;
        Object.assign(this, issueData);
    }

    async fetchIssueComments(): Promise<any[]> {
        const [repoOwner, repoName] = this.repository_url.split('/').slice(-2);
        const { data: comments } = await octokit.issues.listComments({
            owner: repoOwner,
            repo: repoName,
            issue_number: this.number
        });
        return comments;
    }

    async fetchAssociatedPRs(): Promise<any[]> {
        const [repoOwner, repoName] = this.repository_url.split('/').slice(-2);
        const { data: prs } = await octokit.pulls.list({
            owner: repoOwner,
            repo: repoName,
            state: 'all'
        });
        return prs.filter(pr => 
            pr.body && (pr.body.includes(`#${this.number}`) || pr.body.includes(this.html_url))
        );
    }

    async fetchPrData(pr: any): Promise<any[]> {
        const graphqlData = await fetchPrDataGraphql(pr.node_id);
        const prData = [
            {
                id: graphqlData.id,
                text: graphqlData.body,
                issue_id: this.node_id,
                userLogin: graphqlData.author.login,
                payload: {
                    title: graphqlData.title,
                    body: graphqlData.body,
                    owner: graphqlData.author.login,
                    repo: pr.base.repo.name,
                    pull_request: {
                        number: pr.number,
                        url: pr.html_url
                    }
                }
            }
        ];

        graphqlData.comments.nodes.forEach(async (comment: any) => {
            prData.push({
                id: comment.id,
                text: comment.body,
                issue_id: this.node_id,
                userLogin: comment.author.login,
                payload : {
                    title: graphqlData.title,
                    body: graphqlData.body,
                    owner: graphqlData.author.login,
                    repo: pr.base.repo.name,
                    pull_request: {
                        number: pr.number,
                        url: pr.html_url
                    }
                }
            });
        });

        graphqlData.reviewThreads.nodes.forEach((thread: any) => {
            thread.comments.nodes.forEach(async (comment: any) => {
                prData.push({
                    id: comment.id,
                    text: comment.body,
                    userLogin: comment.author.login,
                    issue_id: this.node_id,
                    payload: {
                        title: graphqlData.title,
                        body: graphqlData.body,
                        owner: graphqlData.author.login,
                        repo: pr.base.repo.name,
                        pull_request: {
                            number: pr.number,
                            url: pr.html_url
                        }
                    }
                });
            });
        });

        return prData;
    }

    async fetchAllRelatedData(): Promise<any[]> {
        const [repoOwner, repoName] = this.repository_url.split('/').slice(-2);
        const allData = [
            {
                id: this.node_id,
                text: this.body,
                issue_id: this.node_id,
                userLogin: this.userLogin,
                payload: await fetchPayloadIssue(this.number, repoOwner, repoName)
            }
        ];

        const issueComments = await this.fetchIssueComments();
        issueComments.forEach(async (comment) => {
            const [repoOwner, repoName] = this.repository_url.split('/').slice(-2);
            let payload = await fetchPayloadComment(comment.id, repoOwner, repoName);
            allData.push({
                id: comment.node_id,
                text: comment.body,
                issue_id: this.node_id,
                userLogin: comment.user.login,
                payload: payload
            });
        });

        const associatedPRs = await this.fetchAssociatedPRs();
        for (const pr of associatedPRs) {
            allData.push(...await this.fetchPrData(pr));
        }

        return allData;
    }
}

function importJson(): any[] {
    const rawData = fs.readFileSync('devpool-issues.json', 'utf8');
    return JSON.parse(rawData);
}

function saveIssuesToCsv(allData: any[], fileName: string): void {
    const rows = allData.map(item => ({
        id: item.id,
        plaintext: item.plaintext,
        embedding: formatEmbedding(item.embedding),
        payload: JSON.stringify(item.payload),
        author_id: item.author_id,
        created_at: item.created_at,
        modified_at: item.modified_at,
        markdown: item.markdown
    }));

    csv.writeToPath(fileName, rows, {
        headers: true,
        quoteColumns: true,
        quoteHeaders: true
    })
        .on('error', err => console.error(err))
        .on('finish', () => console.log(`Issue data has been saved to ${fileName}.`));
}

function saveCommentsToCsv(allData: any[], fileName: string): void {
    const rows = allData.map(item => ({
        id: item.id,
        plaintext: item.plaintext,
        markdown: item.markdown,
        embedding: formatEmbedding(item.embedding),
        payload: JSON.stringify(item.payload),
        author_id: item.author_id,
        created_at: item.created_at,
        modified_at: item.modified_at,
        issue_id: item.issue_id
    }));

    csv.writeToPath(fileName, rows, {
        headers: true,
        quoteColumns: true,
        quoteHeaders: true
    })
        .on('error', err => console.error(err))
        .on('finish', () => console.log(`Comments data has been saved to ${fileName} following the required schema.`));
}


async function processIssues(): Promise<void> {
    const data = importJson();
    const issueDataList: any[] = [];
    const commentDataList: any[] = [];
    
    const issueIds = new Set<string>();
    const commentIds = new Set<string>();
    
    for (const issueData of data) {
        const issue = new Issue(issueData);
        console.log(`Processing issue ${issue.number}...`);

        if (!issue.body) {
            console.log(`Skipping issue ${issue.number} as it has no body.`);
            continue;
        }

        const allRelatedData = await issue.fetchAllRelatedData();
        for (const item of allRelatedData) {
            const cleanedText = await cleanMarkdown(item.text);
            const embedding = await extractEmbeddings(cleanedText);
            const authorId = await fetchAuthorId(item.userLogin);
            const entry = {
                id: item.id,
                plaintext: cleanText(cleanedText),
                embedding: embedding,
                author_id: authorId,
                created_at: getCurrentTimestamp(),
                modified_at: getCurrentTimestamp(),
                markdown: cleanText(item.text),
                issue_id: issue.node_id,
                payload: item.payload
            };

            if (item.id.includes("PR") || item.id.includes("IC")) {
                if (!commentIds.has(item.id)) {
                    commentDataList.push(entry);
                    commentIds.add(item.id);
                }
            } else {
                if (!issueIds.has(item.id)) {
                    issueDataList.push(entry);
                    issueIds.add(item.id);
                }
            }
        }
    }

    saveIssuesToCsv(issueDataList, "issues_data.csv");
    saveCommentsToCsv(commentDataList, "comments_data.csv");
}

processIssues().catch(console.error);