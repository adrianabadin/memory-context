export class DatabaseClient {
  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return [];
  }
}
