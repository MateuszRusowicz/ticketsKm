-- Plan 04 (inventory): order references, per-ticket names, page guard,
-- and the counter invariants Postgres can enforce for us.

-- Order references are KM-{YYYY}-{NNNNNN}. A sequence rather than random
-- characters: references are monotonic and support-friendly, and nextval
-- cannot collide, which removes any need for a retry on insert.
CREATE SEQUENCE "order_reference_seq";

-- attendeeNames: one entry per admission, shaped [{ index, name }].
ALTER TABLE "Order" ADD COLUMN "attendeeNames" JSONB;

-- accessToken guards the public order page and the Cancel action, because
-- the reference above is enumerable by design.
--
-- Added WITH a volatile default so any pre-existing row is backfilled with a
-- distinct UUID, then the default is dropped: Prisma's @default(uuid()) is
-- client-side, so leaving a database-level default here would be drift that
-- the next `migrate dev` tries to remove.
ALTER TABLE "Order" ADD COLUMN "accessToken" TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "Order" ALTER COLUMN "accessToken" DROP DEFAULT;

-- The capacity invariant spans Event.capacity and TicketType's two counters,
-- so Postgres cannot enforce it. These two halves it can: a counter that has
-- gone negative is drift, and drift in heldCount silently destroys capacity.
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_heldCount_nonneg" CHECK ("heldCount" >= 0);
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_soldCount_nonneg" CHECK ("soldCount" >= 0);

ALTER TABLE "Order" ADD CONSTRAINT "Order_attendeeNames_is_array"
  CHECK ("attendeeNames" IS NULL OR jsonb_typeof("attendeeNames") = 'array');

-- Supports the same-buyer dedupe in createOrder: finding a PENDING order by
-- email + ticketTypeId joins Order (already indexed on email) back to
-- OrderItem, which would otherwise scan.
CREATE INDEX "OrderItem_ticketTypeId_orderId_idx"
  ON "OrderItem" ("ticketTypeId")
  INCLUDE ("orderId");
