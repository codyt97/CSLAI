import { buildRfqDataReadinessSummary } from '../../../lib/rfqDataReadiness.js';

export async function GET() {
  return Response.json(buildRfqDataReadinessSummary());
}
