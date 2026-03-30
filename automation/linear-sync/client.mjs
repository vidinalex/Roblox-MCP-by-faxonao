const linearEndpoint = "https://api.linear.app/graphql";

async function linearRequest(apiKey, query, variables = {}) {
  const response = await fetch(linearEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey
    },
    body: JSON.stringify({
      query,
      variables
    })
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length > 0) {
    throw new Error(payload.errors?.[0]?.message || `Linear request failed with ${response.status}`);
  }
  return payload.data;
}

export class LinearClient {
  constructor(options) {
    this.apiKey = options.apiKey;
  }

  async fetchRecentIssues(options = {}) {
    const query = `
      query RecentIssues($after: String, $first: Int) {
        issues(
          first: $first,
          orderBy: updatedAt,
          after: $after
        ) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            identifier
            title
            description
            url
            updatedAt
            team { id name }
            project { id name }
            state { id name }
            labels { nodes { id name } }
          }
        }
      }
    `;
    const data = await linearRequest(this.apiKey, query, {
      after: options.after || null,
      first: options.first || 50
    });
    return data.issues;
  }

  async fetchRecentIssueWindow(options = {}) {
    const first = Math.max(1, Math.min(Number(options.first) || 50, 100));
    const pages = Math.max(1, Math.min(Number(options.pages) || 1, 5));
    const nodes = [];
    let cursor = options.after || null;
    let lastPageInfo = null;

    for (let index = 0; index < pages; index += 1) {
      const page = await this.fetchRecentIssues({
        after: cursor,
        first
      });
      nodes.push(...(page.nodes || []));
      lastPageInfo = page.pageInfo || null;
      if (!page.pageInfo?.hasNextPage || !page.pageInfo?.endCursor) {
        break;
      }
      cursor = page.pageInfo.endCursor;
    }

    return {
      nodes,
      pageInfo: lastPageInfo || { hasNextPage: false, endCursor: cursor }
    };
  }

  async createComment(issueId, body) {
    const mutation = `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `;
    return await linearRequest(this.apiKey, mutation, {
      issueId,
      body
    });
  }
}
