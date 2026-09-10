import { runAiRouteOptimizer } from '../../../lib/aiNetworkOptimizer.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req) {
  try {
    const body = await req.json();
    const result = await runAiRouteOptimizer(body);
    return Response.json(result, { status: 200 });
  } catch (err) {
    console.error('AI route optimizer failed:', err);
    return Response.json({
      aiExecuted: false,
      optimizationAccepted: false,
      calculationStatus: 'NOT OPTIMIZED',
      error: err?.message || 'Unexpected optimizer error.'
    }, { status: 500 });
  }
}
