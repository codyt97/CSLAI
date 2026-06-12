import { buildRfqSavingsAnalysis } from '../../../lib/rfqSavingsEngine.js';

export async function GET() {
  return Response.json(buildRfqSavingsAnalysis());
}
