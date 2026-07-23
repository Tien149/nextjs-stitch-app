CREATE TABLE "ItemUnitConversion" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL,
    "unitName" TEXT,
    "conversionRate" DOUBLE PRECISION NOT NULL,
    "isDefaultPurchase" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemUnitConversion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ItemUnitConversion_itemId_unitCode_key" ON "ItemUnitConversion"("itemId", "unitCode");
CREATE INDEX "ItemUnitConversion_unitCode_idx" ON "ItemUnitConversion"("unitCode");
CREATE INDEX "ItemUnitConversion_isDefaultPurchase_idx" ON "ItemUnitConversion"("isDefaultPurchase");

ALTER TABLE "ItemUnitConversion" ADD CONSTRAINT "ItemUnitConversion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
