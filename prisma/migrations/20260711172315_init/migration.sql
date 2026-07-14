-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "partner" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterDataItem" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT,
    "branch" TEXT,
    "taxCode" TEXT,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "accountNo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MasterDataItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "receivedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "partnerCode" TEXT NOT NULL,
    "partnerName" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "moneySourceCode" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "remainingAmount" DOUBLE PRECISION NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HOLDING',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositHistory" (
    "id" TEXT NOT NULL,
    "depositId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "amount" DOUBLE PRECISION,
    "note" TEXT,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepositHistory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DepositHistory_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "Deposit"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OpeningBalance" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "balanceType" TEXT NOT NULL,
    "objectCode" TEXT,
    "objectName" TEXT,
    "moneySourceCode" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpeningBalance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_code_key" ON "Document"("code");

-- CreateIndex
CREATE UNIQUE INDEX "MasterDataItem_type_code_key" ON "MasterDataItem"("type", "code");

-- CreateIndex
CREATE INDEX "MasterDataItem_type_idx" ON "MasterDataItem"("type");

-- CreateIndex
CREATE INDEX "MasterDataItem_status_idx" ON "MasterDataItem"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_code_key" ON "Deposit"("code");

-- CreateIndex
CREATE INDEX "Deposit_status_idx" ON "Deposit"("status");

-- CreateIndex
CREATE INDEX "Deposit_partnerCode_idx" ON "Deposit"("partnerCode");

-- CreateIndex
CREATE INDEX "Deposit_branchCode_idx" ON "Deposit"("branchCode");

-- CreateIndex
CREATE INDEX "DepositHistory_depositId_idx" ON "DepositHistory"("depositId");

-- CreateIndex
CREATE INDEX "OpeningBalance_period_idx" ON "OpeningBalance"("period");

-- CreateIndex
CREATE INDEX "OpeningBalance_balanceType_idx" ON "OpeningBalance"("balanceType");

-- CreateIndex
CREATE INDEX "OpeningBalance_status_idx" ON "OpeningBalance"("status");
