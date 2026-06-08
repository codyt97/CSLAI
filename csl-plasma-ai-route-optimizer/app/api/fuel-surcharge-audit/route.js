import { getFuelSurchargeAudit } from '../../../lib/fuelSurchargeMath.js';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  return Response.json(getFuelSurchargeAudit({ dieselAverage: searchParams.get('dieselAverage') }));
}
