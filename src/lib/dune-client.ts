export class DuneClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.DUNE_API_KEY || '';
    if (!this.apiKey) throw new Error('DUNE_API_KEY not set');
    this.baseUrl = 'https://api.dune.com/api/v1';
  }

  private async request(endpoint: string, options: RequestInit = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'X-DUNE-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Dune API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async getUsage() {
    return this.request('/usage/index');
  }

  async getQuery(queryId: number) {
    return this.request(`/query/${queryId}`);
  }

  async executeQuery(queryId: number, parameters?: Record<string, any>) {
    return this.request(`/query/${queryId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ query_parameters: parameters || {} }),
    });
  }

  async getResults(executionId: string) {
    return this.request(`/execution/${executionId}/results`);
  }

  async createQuery(name: string, query: string, description?: string) {
    return this.request('/query', {
      method: 'POST',
      body: JSON.stringify({ name, query_sql: query, description }),
    });
  }

  async updateQuery(queryId: number, updates: {
    name?: string;
    query?: string;
    description?: string;
  }) {
    return this.request(`/query/${queryId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }
}
