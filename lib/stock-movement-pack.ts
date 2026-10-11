/**
 * Nhật ký nhập/xuất của tab Tồn kho gửi xuống trình duyệt ở dạng GỌN (khách báo màn Kho chậm
 * 11/10/2026): 90 ngày ~32 nghìn dòng, mỗi dòng lặp lại đủ thông tin phiếu + tên hàng nên JSON
 * ~20 MB. Ở đây thông tin phiếu (từng vế) và mặt hàng chỉ gửi một lần, mỗi dòng chỉ còn chỉ số
 * + số lượng / giá — trình duyệt bung lại đúng các dòng cũ bằng unpackStockMovements.
 */

export type StockMovementRow = {
  transactionId: string;
  code: string;
  transactionType: string;
  subType: string | null;
  transactionDate: Date | string;
  branchCode: string;
  warehouseCode: string;
  toWarehouseCode: string | null;
  counterpartWarehouseCode: string | null;
  itemCode: string;
  itemName: string;
  unit: string;
  itemType: string;
  goodsGroup: string | null;
  quantity: number;
  inboundQuantity: number;
  outboundQuantity: number;
  unitCost: number;
  value: number;
  referenceCode: string | null;
  partnerCode: string | null;
  partnerName: string | null;
  note: string | null;
};

/** Một vế phiếu: điều chuyển có hai vế (kho đi / kho nhận) với kho khác nhau. */
type PackedDoc = [
  transactionId: string, code: string, transactionType: string, subType: string | null, transactionDate: string,
  branchCode: string, warehouseCode: string, toWarehouseCode: string | null, counterpartWarehouseCode: string | null,
  referenceCode: string | null, partnerCode: string | null, partnerName: string | null, note: string | null,
];
type PackedItem = [code: string, name: string, unit: string, itemType: string, goodsGroup: string | null];
/** inbound = 1 thì số lượng là nhập, 0 là xuất. */
type PackedLine = [doc: number, item: number, quantity: number, unitCost: number, value: number, inbound: 0 | 1];

export type PackedStockMovements = { docs: PackedDoc[]; items: PackedItem[]; lines: PackedLine[] };

const isoDate = (value: Date | string) => (value instanceof Date ? value.toISOString() : String(value));

export function packStockMovements(rows: StockMovementRow[]): PackedStockMovements {
  const docs: PackedDoc[] = [];
  const items: PackedItem[] = [];
  const lines: PackedLine[] = [];
  const docIndex = new Map<string, number>();
  const itemIndex = new Map<string, number>();
  for (const row of rows) {
    const docKey = `${row.transactionId}|${row.warehouseCode}|${row.toWarehouseCode ?? ""}|${row.counterpartWarehouseCode ?? ""}`;
    let doc = docIndex.get(docKey);
    if (doc === undefined) {
      doc = docs.length;
      docIndex.set(docKey, doc);
      docs.push([
        row.transactionId, row.code, row.transactionType, row.subType, isoDate(row.transactionDate),
        row.branchCode, row.warehouseCode, row.toWarehouseCode, row.counterpartWarehouseCode,
        row.referenceCode, row.partnerCode, row.partnerName, row.note,
      ]);
    }
    let item = itemIndex.get(row.itemCode);
    if (item === undefined) {
      item = items.length;
      itemIndex.set(row.itemCode, item);
      items.push([row.itemCode, row.itemName, row.unit, row.itemType, row.goodsGroup]);
    }
    lines.push([doc, item, row.quantity, row.unitCost, row.value, row.inboundQuantity !== 0 ? 1 : 0]);
  }
  return { docs, items, lines };
}

export function unpackStockMovements(packed: PackedStockMovements): Array<StockMovementRow & { transactionDate: string }> {
  return packed.lines.map(([docIndex, itemIndex, quantity, unitCost, value, inbound]) => {
    const [transactionId, code, transactionType, subType, transactionDate, branchCode, warehouseCode, toWarehouseCode, counterpartWarehouseCode, referenceCode, partnerCode, partnerName, note] = packed.docs[docIndex];
    const [itemCode, itemName, unit, itemType, goodsGroup] = packed.items[itemIndex];
    return {
      transactionId, code, transactionType, subType, transactionDate, branchCode, warehouseCode, toWarehouseCode, counterpartWarehouseCode,
      itemCode, itemName, unit, itemType, goodsGroup,
      quantity, inboundQuantity: inbound ? quantity : 0, outboundQuantity: inbound ? 0 : quantity, unitCost, value,
      referenceCode, partnerCode, partnerName, note,
    };
  });
}
