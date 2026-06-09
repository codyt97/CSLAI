import { getDataSummary } from '../../../lib/dataSummary.js';

export async function GET() {
  return Response.json(getDataSummary());
}
