/*
  Warnings:

  - A unique constraint covering the columns `[stripeRefundId]` on the table `Order` will be added. If there are existing duplicate values, this will fail.

*/
-- Note: DROP INDEX "OrderItem_ticketTypeId_orderId_idx" removed. That index
-- uses INCLUDE ("orderId"), a PostgreSQL-only covering feature that Prisma's
-- schema language cannot represent, so migrate dev always sees it as drift.
-- The index was created intentionally in Plan 04 and must be preserved.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "paymentIntentStatus" TEXT,
ADD COLUMN     "paymentMethodType" TEXT,
ADD COLUMN     "refundRequestedAt" TIMESTAMP(3),
ADD COLUMN     "stripeRefundId" TEXT;

-- AlterTable
ALTER TABLE "StripeWebhookEvent" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deadLettered" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "Order_stripeRefundId_key" ON "Order"("stripeRefundId");

-- CreateIndex
CREATE INDEX "Order_status_holdExpiresAt_paymentIntentStatus_idx" ON "Order"("status", "holdExpiresAt", "paymentIntentStatus");

-- CreateIndex
CREATE INDEX "Order_refundRequestedAt_idx" ON "Order"("refundRequestedAt");

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_processedAt_receivedAt_idx" ON "StripeWebhookEvent"("processedAt", "receivedAt");
