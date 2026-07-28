import { PrismaClient } from "@prisma/custom-client";

const prisma = new PrismaClient();

async function main() {
  console.log("==================================================");
  console.log("🧹 ĐANG XÓA TOÀN BỘ DỮ LIỆU PHÁT SINH (OPERATIONAL DATA)...");
  console.log("🔒 GIỮ NGUYÊN 100%: User, Role, Phân quyền & Danh mục master data.");
  console.log("==================================================\n");

  const tablesToTruncate = [
    "ReconciliationMatch",
    "BankStatementTransaction",
    "RevenueImportRow",
    "PayrollImportRow",
    "ImportRow",
    "ImportBatch",
    "DepositHistory",
    "Deposit",
    "DebtSettlement",
    "DebtRecord",
    "FinancialVoucher",
    "AssetDepreciation",
    "AssetMaintenance",
    "AssetDamageReport",
    "AssetRecord",
    "InventoryTransactionLine",
    "InventoryTransaction",
    "InventoryBalance",
    "StocktakeLine",
    "Stocktake",
    "RecipeLine",
    "Recipe",
    "ItemUnitConversion",
    "PurchaseRequestLine",
    "PurchaseRequest",
    "SupplierQuoteLine",
    "SupplierQuote",
    "PurchaseOrderLine",
    "PurchaseOrder",
    "WorkItemChecklist",
    "WorkItem",
    "AuditLog",
    "JournalLine",
    "JournalEntry",
    "OpeningBalance",
    "Document"
  ];

  for (const table of tablesToTruncate) {
    try {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE;`);
      console.log(`  ✓ Đã làm sạch bảng: "${table}"`);
    } catch (e) {
      console.warn(`  ⚠️ Bảng "${table}" không tồn tại hoặc đã sạch.`);
    }
  }

  console.log("\n==================================================");
  console.log("✅ DỌN DẸP HOÀN TẤT! HỆ THỐNG ĐÃ TRỞ VỀ TRẠNG THÁI MỚI TINH.");
  console.log("Sẵn sàng cho Người dùng / Tester bắt đầu test từ đầu!");
  console.log("==================================================");
}

main()
  .catch((e) => {
    console.error("❌ Lỗi khi dọn dẹp dữ liệu:", e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
