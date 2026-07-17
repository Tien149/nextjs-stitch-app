-- CreateTable
CREATE TABLE "FinancialVoucher" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "voucherType" TEXT NOT NULL,
    "voucherDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "partnerCode" TEXT,
    "partnerName" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "moneySourceCode" TEXT NOT NULL,
    "categoryCode" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialVoucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetRecord" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "departmentCode" TEXT,
    "assetGroup" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "originalCost" DOUBLE PRECISION NOT NULL,
    "currentValue" DOUBLE PRECISION NOT NULL,
    "supplierCode" TEXT,
    "supplierName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IN_USE',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialVoucher_code_key" ON "FinancialVoucher"("code");

-- CreateIndex
CREATE INDEX "FinancialVoucher_voucherType_idx" ON "FinancialVoucher"("voucherType");

-- CreateIndex
CREATE INDEX "FinancialVoucher_voucherDate_idx" ON "FinancialVoucher"("voucherDate");

-- CreateIndex
CREATE INDEX "FinancialVoucher_partnerCode_idx" ON "FinancialVoucher"("partnerCode");

-- CreateIndex
CREATE INDEX "FinancialVoucher_status_idx" ON "FinancialVoucher"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AssetRecord_code_key" ON "AssetRecord"("code");

-- CreateIndex
CREATE INDEX "AssetRecord_branchCode_idx" ON "AssetRecord"("branchCode");

-- CreateIndex
CREATE INDEX "AssetRecord_assetGroup_idx" ON "AssetRecord"("assetGroup");

-- CreateIndex
CREATE INDEX "AssetRecord_status_idx" ON "AssetRecord"("status");
