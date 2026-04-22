export interface Session {
  session_id: string;
  source: string;
  project_path: string | null;
  model: string | null;
  first_timestamp: string | null;
  last_timestamp: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  last_line: number;
}
