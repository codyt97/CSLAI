import { getInvoiceAudit } from '../../../lib/invoiceAuditMath.js';

export async function GET() {
  return Response.json(await getInvoiceAudit());
}
