import { NextResponse } from 'next/server'
import { env } from '@/lib/server/env'
import { sweepExpiredHolds } from '@/lib/server/sweep-holds'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${env.CRON_SECRET}`) {
    return new NextResponse('unauthorized', { status: 401 })
  }

  const r = await sweepExpiredHolds()
  console.error(`SWEEP-PRIMARY expired=${r.expired} released=${r.released} failed=${r.failed}`)
  return NextResponse.json(r, { status: r.failed > 0 ? 207 : 200 })
}
