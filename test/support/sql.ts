import { SQL } from "bun";
import { TEST_DATABASE_URL } from "./test-config";

/**
 * Direct SQL access for assertions and fault setup, through Bun's built-in PostgreSQL client (independent of the
 * application's ORM). Server errors expose the SQLSTATE as `errno`.
 */
export const sql = new SQL(TEST_DATABASE_URL);

export async function sqlStateOf(operation: Promise<unknown>): Promise<string | undefined> {
  try {
    await operation;
    return undefined;
  } catch (error) {
    return (error as { errno?: string }).errno;
  }
}
