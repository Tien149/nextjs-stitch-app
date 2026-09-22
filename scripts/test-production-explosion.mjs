import assert from "node:assert/strict";
import test from "node:test";
import {
  computeRecipeUnitCosts,
  explodeSalesDemand,
  pickRecipeForDate,
} from "../lib/production-explosion.ts";

/**
 * Bộ dữ liệu mô phỏng đúng file mẫu của kế toán:
 *  - BTP_SOTCACHUA: 1 mẻ "lít sốt" = 1000 gr tồn kho, cần 30 gr đường (hao hụt 3%).
 *  - SP_CAHONG: 1 phần dùng 150 gr sốt cà chua + 1 con cá.
 *  - SP_COMBO01: combo = 1 phần SP_CAHONG + 1 chai nước suối.
 *  - NVL_BIA: bán thẳng, không có định lượng.
 */
const items = {
  duong: { id: "i-duong", code: "NVL_DUONG", name: "Đường", unit: "gr", itemType: "RAW_MATERIAL" },
  ca: { id: "i-ca", code: "NVL_CA", name: "Cá hồng", unit: "con", itemType: "RAW_MATERIAL" },
  nuoc: { id: "i-nuoc", code: "NVL_NUOCSUOI", name: "Nước suối", unit: "chai", itemType: "RAW_MATERIAL" },
  sot: { id: "i-sot", code: "BTP_SOTCACHUA", name: "Sốt cà chua", unit: "gr", itemType: "SEMI_FINISHED" },
  cahong: { id: "i-cahong", code: "SP_CAHONG", name: "Cá hồng sốt cà", unit: "PHAN", itemType: "FINISHED" },
  combo: { id: "i-combo", code: "SP_COMBO01", name: "Combo bán POS", unit: "PHAN", itemType: "FINISHED" },
};

const recipes = [
  {
    id: "r-sot",
    productCode: "BTP_SOTCACHUA",
    productName: "Sốt cà chua",
    unit: "lít sốt",
    outputConversionRate: 1000,
    version: 1,
    effectiveFrom: "2026-07-22",
    status: "ACTIVE",
    lines: [
      { itemId: items.duong.id, quantity: 30, conversionRate: 1, wasteRate: 3, item: items.duong },
    ],
  },
  {
    id: "r-cahong",
    productCode: "SP_CAHONG",
    productName: "Cá hồng sốt cà",
    unit: "PHAN",
    outputConversionRate: 1,
    version: 1,
    effectiveFrom: "2026-07-22",
    status: "ACTIVE",
    lines: [
      { itemId: items.sot.id, quantity: 150, conversionRate: 1, wasteRate: 0, item: items.sot },
      { itemId: items.ca.id, quantity: 1, conversionRate: 1, wasteRate: 0, item: items.ca },
    ],
  },
  {
    id: "r-combo",
    productCode: "SP_COMBO01",
    productName: "Combo bán POS",
    unit: "PHAN",
    outputConversionRate: 1,
    version: 1,
    effectiveFrom: "2026-07-22",
    status: "ACTIVE",
    lines: [
      { itemId: items.cahong.id, quantity: 1, conversionRate: 1, wasteRate: 0, item: items.cahong },
      { itemId: items.nuoc.id, quantity: 1, conversionRate: 1, wasteRate: 0, item: items.nuoc },
    ],
  },
];

test("rã combo theo thứ tự BTP → TP → combo và cộng dồn nhu cầu", () => {
  const plan = explodeSalesDemand({
    demands: [
      { productCode: "SP_COMBO01", quantity: 10 },
      { productCode: "SP_CAHONG", quantity: 5 },
      { productCode: "NVL_BIA", quantity: 24 },
    ],
    recipes,
    date: new Date("2026-08-01"),
  });

  assert.deepEqual(plan.productions.map((step) => step.productCode), [
    "BTP_SOTCACHUA",
    "SP_CAHONG",
    "SP_COMBO01",
  ]);

  // 10 combo + 5 phần lẻ = 15 phần cá hồng, mỗi phần 150 gr sốt = 2250 gr sốt.
  const [sot, cahong, combo] = plan.productions;
  assert.equal(cahong.quantityBase, 15);
  assert.equal(sot.quantityBase, 2250);
  // 2250 gr sốt = 2.25 mẻ lít; đường = 30 gr * 1.03 hao hụt * 2.25 mẻ.
  assert.ok(Math.abs(sot.batchQuantity - 2.25) < 1e-9);
  const duong = sot.components.find((component) => component.item.code === "NVL_DUONG");
  assert.ok(Math.abs(duong.quantityBase - 30 * 1.03 * 2.25) < 1e-9);
  // Combo tiêu hao 10 phần cá hồng + 10 chai nước.
  const comboCa = combo.components.find((component) => component.item.code === "SP_CAHONG");
  assert.equal(comboCa.quantityBase, 10);

  // Món có định lượng thì xuất bán sau chế biến, món không có thì bán thẳng.
  assert.deepEqual(
    plan.producedSales.sort((a, b) => a.productCode.localeCompare(b.productCode)),
    [
      { productCode: "SP_CAHONG", quantityBase: 5 },
      { productCode: "SP_COMBO01", quantityBase: 10 },
    ],
  );
  assert.deepEqual(plan.directSales, [{ productCode: "NVL_BIA", quantityBase: 24 }]);
});

test("chọn phiên bản định lượng theo ngày áp dụng", () => {
  const versions = [
    { ...recipes[0], id: "v1", version: 1, effectiveFrom: "2026-07-01" },
    { ...recipes[0], id: "v2", version: 2, effectiveFrom: "2026-08-01" },
  ];
  assert.equal(pickRecipeForDate(versions, new Date("2026-07-15")).id, "v1");
  assert.equal(pickRecipeForDate(versions, new Date("2026-08-01")).id, "v2");
  // Bán trước mọi ngày áp dụng: dùng phiên bản sớm nhất thay vì bỏ rã.
  assert.equal(pickRecipeForDate(versions, new Date("2026-06-01")).id, "v1");
});

test("định lượng khai vòng thì báo lỗi nghiệp vụ rõ ràng", () => {
  const cyclic = [
    {
      ...recipes[0],
      id: "r-a",
      productCode: "BTP_A",
      lines: [{ itemId: "i-b", quantity: 1, conversionRate: 1, wasteRate: 0, item: { id: "i-b", code: "BTP_B", name: "B", unit: "gr", itemType: "SEMI_FINISHED" } }],
    },
    {
      ...recipes[0],
      id: "r-b",
      productCode: "BTP_B",
      lines: [{ itemId: "i-a", quantity: 1, conversionRate: 1, wasteRate: 0, item: { id: "i-a", code: "BTP_A", name: "A", unit: "gr", itemType: "SEMI_FINISHED" } }],
    },
  ];
  assert.throws(
    () => explodeSalesDemand({ demands: [{ productCode: "BTP_A", quantity: 1 }], recipes: cyclic, date: new Date("2026-08-01") }),
    /BUSINESS:.*khai vòng/,
  );
});

test("cost đa cấp: BTP tính từ định lượng, quy đổi ĐVT nguyên liệu", () => {
  const averageCosts = new Map([
    [items.duong.id, 0.5],   // 0.5 đ/gr đường
    [items.ca.id, 40000],    // 40.000 đ/con
    [items.nuoc.id, 5000],   // 5.000 đ/chai
  ]);
  const costs = computeRecipeUnitCosts(recipes, averageCosts, new Date("2026-08-01"));
  // 1 mẻ sốt: 30 gr * 1.03 * 0.5 đ = 15.45 đ / 1000 gr => 0.01545 đ/gr.
  assert.ok(Math.abs(costs.get("BTP_SOTCACHUA") - 0.01545) < 1e-9);
  // 1 phần cá hồng = 150 gr sốt (theo cost BTP) + 1 con cá.
  const expectedCaHong = 150 * 0.01545 + 40000;
  assert.ok(Math.abs(costs.get("SP_CAHONG") - expectedCaHong) < 1e-6);
  // Combo = 1 phần cá hồng + 1 chai nước.
  assert.ok(Math.abs(costs.get("SP_COMBO01") - (expectedCaHong + 5000)) < 1e-6);
});

test("nguyên liệu khai bằng ĐVT quy đổi nhân đúng hệ số", () => {
  const withConversion = [{
    ...recipes[0],
    id: "r-tuongot",
    productCode: "BTP_SOTME",
    outputConversionRate: 1,
    lines: [{
      itemId: "i-tuongot",
      quantity: 2,
      conversionRate: 830, // 2 chai830gr = 1660 gr tương ớt
      wasteRate: 0,
      item: { id: "i-tuongot", code: "NVL_TUONGOT", name: "Tương ớt", unit: "gr", itemType: "RAW_MATERIAL" },
    }],
  }];
  const plan = explodeSalesDemand({
    demands: [{ productCode: "BTP_SOTME", quantity: 1 }],
    recipes: withConversion,
    date: new Date("2026-08-01"),
  });
  assert.equal(plan.productions[0].components[0].quantityBase, 1660);
});

/**
 * BOM theo cửa hàng (khách chốt 20/09/2026): cùng mã bán thành phẩm nhưng mỗi cửa hàng pha
 * một công thức. Bản khai không có cửa hàng = dùng chung; nơi khai riêng thì dùng bản riêng.
 */
const sharedSauce = recipes[0];
const asaSauce = {
  ...recipes[0],
  id: "r-sot-asa",
  branchCode: "ASA",
  lines: [{ itemId: items.duong.id, quantity: 45, conversionRate: 1, wasteRate: 3, item: items.duong }],
};

test("cửa hàng có công thức riêng thì rã theo bản riêng, nơi khác ăn bản chung", () => {
  const branchRecipes = [sharedSauce, asaSauce];
  const asa = explodeSalesDemand({
    demands: [{ productCode: "BTP_SOTCACHUA", quantity: 1000 }],
    recipes: branchRecipes,
    date: new Date("2026-08-01"),
    branchCode: "ASA",
  });
  // 1 mẻ 1000 gr sốt ở ASA: 45 gr đường * 1.03.
  assert.ok(Math.abs(asa.productions[0].components[0].quantityBase - 45 * 1.03) < 1e-9);

  const nme = explodeSalesDemand({
    demands: [{ productCode: "BTP_SOTCACHUA", quantity: 1000 }],
    recipes: branchRecipes,
    date: new Date("2026-08-01"),
    branchCode: "NME",
  });
  // NME chưa khai riêng -> bản dùng chung: 30 gr đường * 1.03.
  assert.ok(Math.abs(nme.productions[0].components[0].quantityBase - 30 * 1.03) < 1e-9);
});

test("bản riêng của cửa hàng khác không bao giờ bị đem sang", () => {
  // Món CHỈ có bản riêng của ASA: cửa hàng NME không được lấy bản đó để rã.
  const onlyAsa = [asaSauce];
  const picked = pickRecipeForDate(onlyAsa, new Date("2026-08-01"), "NME");
  assert.equal(picked, null);
  assert.equal(pickRecipeForDate(onlyAsa, new Date("2026-08-01"), "ASA").id, "r-sot-asa");
});

test("giá thành tính riêng theo từng cửa hàng", () => {
  const averageCosts = new Map([[items.duong.id, 0.5]]);
  const branchRecipes = [sharedSauce, asaSauce];
  const shared = computeRecipeUnitCosts(branchRecipes, averageCosts, new Date("2026-08-01"));
  const asa = computeRecipeUnitCosts(branchRecipes, averageCosts, new Date("2026-08-01"), "ASA");
  assert.ok(Math.abs(shared.get("BTP_SOTCACHUA") - 30 * 1.03 * 0.5 / 1000) < 1e-12);
  assert.ok(Math.abs(asa.get("BTP_SOTCACHUA") - 45 * 1.03 * 0.5 / 1000) < 1e-12);
});

/**
 * Dữ liệu thật (ASA, 01/08/2026): 9.096 dòng định lượng khai ĐVT trùng ĐVT tồn kho mà hệ số
 * vẫn 1000 ("300 GR × 1000" cho nguyên liệu tính bằng GR). Đọc thẳng hệ số đó thì mỗi cấp
 * bán thành phẩm nhân sai 1000 lần và nhân chồng qua các cấp — nhu cầu cà chua lên 1,4 triệu
 * tấn, rã BOM chết vì "Khong the xuat vuot ton kho". Luật bất biến lib/unit-conversion.ts.
 */
test("ĐVT khai trùng ĐVT tồn kho thì hệ số quy đổi phải là 1", () => {
  const selfReferencing = [{
    ...recipes[0],
    id: "r-sotca",
    productCode: "BTP_SOTCA",
    outputConversionRate: 1000, // 1 mẻ KG = 1000 gr
    lines: [{
      itemId: "i-cachua",
      quantity: 300,
      unitCode: "GR",
      conversionRate: 1000, // khai sai: 300 GR mà nhân tiếp 1000
      wasteRate: 0,
      item: { id: "i-cachua", code: "NVL_CACHUA", name: "Cà chua", unit: "GR", itemType: "RAW_MATERIAL" },
    }],
  }];
  const plan = explodeSalesDemand({
    demands: [{ productCode: "BTP_SOTCA", quantity: 1000 }],
    recipes: selfReferencing,
    date: new Date("2026-08-01"),
  });
  // 1000 gr sốt = 1 mẻ -> đúng 300 gr cà chua, không phải 300.000.
  assert.equal(plan.productions[0].components[0].quantityBase, 300);
});
