import { NextResponse } from 'next/server'
import { env } from '@/lib/server/env'
import { reconcile } from '@/lib/server/reconcile'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${env.CRON_SECRET}`) {
    return new NextResponse('unauthorized', { status: 401 })
  }

  const r = await reconcile()
  return NextResponse.json(r, { status: r.alerts > 0 ? 207 : 200 })
}
