/**
 * Rà & sửa dòng quy đổi ĐVT khai sai kiểu "1 KG = 1000 KG" (ĐVT mua trùng ĐVT tồn kho
 * nhưng tỷ lệ khác 1). Một đơn vị không thể quy đổi ra chính nó với tỷ lệ khác 1 — dữ liệu
 * này làm mọi phép nhân số lượng sai gấp `conversionRate` lần (nhận 1.000 lít thành
 * 1.000.000 lít, yêu cầu mua 1 lít thành 1.000 lít).
 *
 * Code đã có lớp chặn (lib/unit-conversion.ts) nên ứng dụng chạy đúng dù dữ liệu còn sai;
 * script này chỉ để dọn cho danh mục hiển thị đúng.
 *
 *   node scripts/repair-self-referencing-unit-conversions.cjs             # chỉ báo cáo (mặc định)
 *   node scripts/repair-self-referencing-unit-conversions.cjs --apply     # sửa tỷ lệ về 1
 *   node scripts/repair-self-referencing-unit-conversions.cjs --apply --delete-rows
 *                                                                        # xoá hẳn dòng quy đổi thừa
 */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const deleteRows = process.argv.includes("--delete-rows");

(async () => {
  const items = await prisma.inventoryItem.findMany({
    where: { deletedAt: null },
    include: { unitConversions: { where: { deletedAt: null } } },
    orderBy: { code: "asc" },
  });

  const broken = [];
  for (const item of items) {
    for (const conversion of item.unitConversions) {
      const sameUnit = conversion.unitCode.trim().toUpperCase() === item.unit.trim().toUpperCase();
      if (sameUnit && conversion.conversionRate !== 1) {
        broken.push({ conversionId: conversion.id, code: item.code, name: item.name, unit: item.unit, rate: conversion.conversionRate });
      }
    }
  }

  console.log(`Tổng mặt hàng đang hoạt động: ${items.length}`);
  console.log(`Dòng quy đổi khai sai "1 X = n X": ${broken.length}`);

  const byRate = new Map();
  for (const row of broken) byRate.set(row.rate, (byRate.get(row.rate) || 0) + 1);
  console.log("\nPhân bố tỷ lệ sai:");
  for (const [rate, count] of [...byRate.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  1 X = ${rate} X : ${count} mặt hàng`);
  }

  console.log("\n20 ví dụ đầu:");
  for (const row of broken.slice(0, 20)) {
    console.log(`  ${row.code} "${row.name}" — ĐVT tồn ${row.unit}, quy đổi 1 ${row.unit} = ${row.rate} ${row.unit}`);
  }

  if (!apply) {
    console.log(`\n(chưa sửa gì — thêm --apply để ${deleteRows ? "xoá hẳn dòng quy đổi" : "đưa tỷ lệ về 1"})`);
    console.log("LƯU Ý: nếu ý định thật là \"1 KG = 1000 G\" thì phải sửa ĐVT tồn kho của mặt hàng thành G/ML");
    console.log("trước (ảnh hưởng định lượng + giá vốn), đừng chỉ chạy script này.");
    await prisma.$disconnect();
    return;
  }

  const ids = broken.map((row) => row.conversionId);
  if (deleteRows) {
    const result = await prisma.itemUnitConversion.deleteMany({ where: { id: { in: ids } } });
    console.log(`\n✔ Đã xoá ${result.count} dòng quy đổi thừa.`);
  } else {
    const result = await prisma.itemUnitConversion.updateMany({
      where: { id: { in: ids } },
      data: { conversionRate: 1, isDefaultPurchase: false, note: "Sửa tỷ lệ tự quy đổi về 1 (dữ liệu cũ khai sai)" },
    });
    console.log(`\n✔ Đã đưa ${result.count} dòng quy đổi về tỷ lệ 1.`);
  }
  await prisma.$disconnect();
})();
