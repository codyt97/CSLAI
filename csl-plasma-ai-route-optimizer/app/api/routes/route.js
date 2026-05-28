import { groupRouteRecords, getRouteGroup, getAllRecords } from '../../../lib/routeMath.js';
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const routeName = searchParams.get('routeName');
  if (routeName) return Response.json(getRouteGroup(routeName) || { error: 'Route not found' });
  return Response.json({ routes: groupRouteRecords({ openOnly: searchParams.get('openOnly') !== 'false' }), records: searchParams.get('includeRecords') === 'true' ? getAllRecords() : undefined });
}
