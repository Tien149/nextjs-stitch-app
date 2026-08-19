-- Phiếu phân bổ chi phí liên nhà hàng: nhà hàng trả hộ chuyển bớt chi phí cho nhà hàng khác,
-- kèm công nợ nội bộ để đòi lại tiền.
CREATE TABLE "CostReallocation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "documentDate" TIMESTAMP(3) NOT NULL,
    "period" TEXT NOT NULL,
    "fromBranchCode" TEXT NOT NULL,
    "pnlItemCode" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "CostReallocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CostReallocation_code_key" ON "CostReallocation"("code");
CREATE INDEX "CostReallocation_period_idx" ON "CostReallocation"("period");
CREATE INDEX "CostReallocation_fromBranchCode_idx" ON "CostReallocation"("fromBranchCode");
CREATE INDEX "CostReallocation_deletedAt_idx" ON "CostReallocation"("deletedAt");

CREATE TABLE "CostReallocationLine" (
    "id" TEXT NOT NULL,
    "reallocationId" TEXT NOT NULL,
    "toBranchCode" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "receivableDebtCode" TEXT,
    "payableDebtCode" TEXT,
    "note" TEXT,

    CONSTRAINT "CostReallocationLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CostReallocationLine_reallocationId_idx" ON "CostReallocationLine"("reallocationId");
CREATE INDEX "CostReallocationLine_toBranchCode_idx" ON "CostReallocationLine"("toBranchCode");

ALTER TABLE "CostReallocationLine" ADD CONSTRAINT "CostReallocationLine_reallocationId_fkey" FOREIGN KEY ("reallocationId") REFERENCES "CostReallocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
