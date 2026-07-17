"use client";

import { useEffect, useState } from "react";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { canPerformMenuAction } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";

type Item = { id: string; code: string; name: string; unit: string; itemType: string; minStock: number };
type Balance = { id: string; warehouseCode: string; quantity: number; averageCost: number; item: Item };
type Transaction = { id: string; code: string; transactionType: string; transactionDate: string; warehouseCode: string; referenceCode: string | null; lines: Array<{ id: string; quantity: number; unitCost: number; totalCost: number; item: Item }> };
type Recipe = { id: string; code: string; productCode: string; productName: string; sellingPrice: number; estimatedCost: number; version: number; lines: Array<{ quantity: number; wasteRate: number; item: Item }> };
type Data = { items: Item[]; balances: Balance[]; transactions: Transaction[]; recipes: Recipe[] };
const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);

export default function InventoryPage() {
  const href = "/inventory";
  const { user, loading } = useModuleAuth(href);
  const [active, setActive] = useState("stock");
  const [data, setData] = useState<Data>({ items: [], balances: [], transactions: [], recipes: [] });
  const [message, setMessage] = useState("");
  
  const [itemForm, setItemForm] = useState({ code: "NVL_001", name: "Nguyên liệu mẫu", unit: "kg", itemType: "MATERIAL", minStock: "5" });
  const [stockForm, setStockForm] = useState({ transactionType: "RECEIPT", branchCode: "HCM", warehouseCode: "KHO_HCM", itemId: "", quantity: "10", unitCost: "100000", referenceCode: "", note: "Nhập kho vận hành" });
  const [recipeForm, setRecipeForm] = useState({ productCode: "SP_001", productName: "Sản phẩm mẫu", sellingPrice: "45000", itemId: "", quantity: "0.02", wasteRate: "3" });
  const [wasteForm, setWasteForm] = useState({ recipeId: "", productQuantity: "1", branchCode: "HCM", warehouseCode: "KHO_HCM", referenceCode: "", note: "Hủy hàng theo báo cáo POS" });
  
  const canCreate = user ? canPerformMenuAction(user.role, href, "create") : false;

  const loadData = async () => {
    const response = await fetch("/api/inventory");
    if (!response.ok) return;
    const payload = await response.json() as Data;
    setData(payload);
    const firstItem = payload.items[0]?.id || "";
    const firstRecipe = payload.recipes[0]?.id || "";
    setStockForm((form) => ({ ...form, itemId: form.itemId || firstItem }));
    setRecipeForm((form) => ({ ...form, itemId: form.itemId || firstItem }));
    setWasteForm((form) => ({ ...form, recipeId: form.recipeId || firstRecipe }));
  };

  useEffect(() => { if (!loading) window.setTimeout(() => void loadData(), 0); }, [loading]);

  const send = async (body: object, success: string) => {
    setMessage("");
    const response = await fetch("/api/inventory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json();
    setMessage(response.ok ? success : payload.error || "Không thực hiện được thao tác");
    if (response.ok) await loadData();
  };

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;
  
  return (
    <ModuleFrame title="Kho & Định lượng" subtitle="GĐ3 - tồn kho, giá bình quân, recipe và hủy hàng" role={user?.role}>
      <ModuleTabs active={active} onChange={setActive} tabs={[{ id: "stock", label: "Tồn kho", icon: "inventory" }, { id: "transactions", label: "Nhập / Xuất", icon: "swap_horiz" }, { id: "items", label: "Mặt hàng", icon: "category" }, { id: "recipes", label: "Định lượng", icon: "menu_book" }, { id: "waste", label: "Hủy hàng", icon: "delete_sweep" }]} />
      {message && <p className="mb-4 px-4 py-3 rounded-lg border border-blue-100 bg-blue-50 text-sm text-blue-700">{message}</p>}

      {active === "stock" && (
        <section className="table-panel shadow-sm">
          <Panel title="Tồn kho theo kho" reload={loadData} />
          <Table
            headers={[
              { label: "Mặt hàng" },
              { label: "Kho" },
              { label: "Số lượng", align: "right" },
              { label: "Giá bình quân", align: "right" },
              { label: "Giá trị", align: "right" },
              { label: "Cảnh báo" },
            ]}
          >
            {data.balances.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <Cell>
                  <b>{row.item.code} - {row.item.name}</b>
                  <small>{row.item.itemType} · {row.item.unit}</small>
                </Cell>
                <Cell>{row.warehouseCode}</Cell>
                <Cell right><b>{money(row.quantity)}</b> {row.item.unit}</Cell>
                <Cell right>{money(row.averageCost)} đ</Cell>
                <Cell right><b>{money(row.quantity * row.averageCost)} đ</b></Cell>
                <Cell>{row.quantity < row.item.minStock ? <span className="status bg-rose-50 text-rose-700">Dưới định mức</span> : <span className="status bg-emerald-50 text-emerald-700">Đủ tồn</span>}</Cell>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {active === "items" && (
        <div className="grid lg:grid-cols-[360px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "CREATE_ITEM", ...itemForm }, "Đã tạo mặt hàng."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Thêm mặt hàng</h2>
              
              <Input label="Mã">
                <input data-input-kind="code" className="control" value={itemForm.code} onChange={(e) => setItemForm({ ...itemForm, code: e.target.value })} />
              </Input>
              
              <Input label="Tên">
                <input className="control" value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} />
              </Input>
              
              <div className="grid grid-cols-2 gap-3">
                <Input label="Đơn vị">
                  <input className="control" value={itemForm.unit} onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })} />
                </Input>
                <Input label="Tồn tối thiểu">
                  <input type="number" className="control" value={itemForm.minStock} onChange={(e) => setItemForm({ ...itemForm, minStock: e.target.value })} />
                </Input>
              </div>
              
              <Input label="Loại">
                <select className="control" value={itemForm.itemType} onChange={(e) => setItemForm({ ...itemForm, itemType: e.target.value })}>
                  <option value="MATERIAL">Nguyên liệu</option>
                  <option value="PACKAGING">Bao bì</option>
                  <option value="TOOL">CCDC</option>
                  <option value="ASSET">Tài sản</option>
                </select>
              </Input>
              
              <button className="primary-button w-full">
                <span className="material-symbols-outlined text-lg">add</span>Thêm mặt hàng
              </button>
            </form>
          )}
          
          <section className="table-panel shadow-sm">
            <Panel title="Danh mục mặt hàng" reload={loadData} />
            <Table
              headers={[
                { label: "Mã" },
                { label: "Tên" },
                { label: "Loại" },
                { label: "Đơn vị" },
                { label: "Tồn tối thiểu", align: "right" },
              ]}
            >
              {data.items.map((item) => (
                <tr key={item.id} className="border-t border-slate-100">
                  <Cell><b>{item.code}</b></Cell>
                  <Cell>{item.name}</Cell>
                  <Cell>{item.itemType}</Cell>
                  <Cell>{item.unit}</Cell>
                  <Cell right>{money(item.minStock)}</Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "transactions" && (
        <div className="grid lg:grid-cols-[380px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "STOCK_TRANSACTION", ...stockForm, lines: [{ itemId: stockForm.itemId, quantity: stockForm.quantity, unitCost: stockForm.unitCost }] }, "Đã ghi nhận giao dịch kho."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Ghi nhận nhập / xuất</h2>
              
              <Input label="Loại">
                <select className="control" value={stockForm.transactionType} onChange={(e) => setStockForm({ ...stockForm, transactionType: e.target.value })}>
                  <option value="RECEIPT">Nhập kho</option>
                  <option value="ISSUE">Xuất kho</option>
                </select>
              </Input>
              
              <Input label="Mặt hàng">
                <ItemSelect items={data.items} value={stockForm.itemId} onChange={(itemId) => setStockForm({ ...stockForm, itemId })} />
              </Input>
              
              <div className="grid grid-cols-2 gap-3">
                <Input label="Chi nhánh">
                  <select
                    value={stockForm.branchCode}
                    onChange={(e) => setStockForm({ ...stockForm, branchCode: e.target.value })}
                    className="control"
                  >
                    <option value="HCM">CN Hồ Chí Minh</option>
                    <option value="HN">CN Hà Nội</option>
                  </select>
                </Input>
                <Input label="Kho">
                  <select
                    value={stockForm.warehouseCode}
                    onChange={(e) => setStockForm({ ...stockForm, warehouseCode: e.target.value })}
                    className="control"
                  >
                    <option value="KHO_HCM">Kho HCM</option>
                    <option value="KHO_HN">Kho HN</option>
                  </select>
                </Input>
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                <Input label="Số lượng">
                  <input type="number" step="0.01" className="control" value={stockForm.quantity} onChange={(e) => setStockForm({ ...stockForm, quantity: e.target.value })} />
                </Input>
                <Input label="Đơn giá nhập">
                  <input type="number" className="control" value={stockForm.unitCost} onChange={(e) => setStockForm({ ...stockForm, unitCost: e.target.value })} />
                </Input>
              </div>
              
              <Input label="Tham chiếu">
                <input data-input-kind="code" className="control" value={stockForm.referenceCode} onChange={(e) => setStockForm({ ...stockForm, referenceCode: e.target.value })} />
              </Input>
              
              <button className="primary-button w-full">Ghi nhận</button>
            </form>
          )}
          
          <section className="table-panel shadow-sm">
            <Panel title="Thẻ kho gần nhất" reload={loadData} />
            <Table
              headers={[
                { label: "Chứng từ" },
                { label: "Loại" },
                { label: "Kho" },
                { label: "Mặt hàng" },
                { label: "Giá trị", align: "right" },
              ]}
            >
              {data.transactions.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <Cell><b>{row.code}</b><small>{new Date(row.transactionDate).toLocaleDateString("vi-VN")}</small></Cell>
                  <Cell><span className="status bg-slate-100">{row.transactionType}</span></Cell>
                  <Cell>{row.warehouseCode}</Cell>
                  <Cell>{row.lines.map((line) => `${line.item.name}: ${line.quantity}`).join(", ")}</Cell>
                  <Cell right><b>{money(row.lines.reduce((sum, line) => sum + line.totalCost, 0))} đ</b></Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "recipes" && (
        <div className="grid lg:grid-cols-[380px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "CREATE_RECIPE", ...recipeForm, lines: [{ itemId: recipeForm.itemId, quantity: recipeForm.quantity, wasteRate: recipeForm.wasteRate }] }, "Đã tạo phiên bản định lượng mới."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Tạo định lượng</h2>
              
              <div className="grid grid-cols-2 gap-3">
                <Input label="Mã món">
                  <input data-input-kind="code" className="control" value={recipeForm.productCode} onChange={(e) => setRecipeForm({ ...recipeForm, productCode: e.target.value })} />
                </Input>
                <Input label="Giá bán">
                  <input type="number" className="control" value={recipeForm.sellingPrice} onChange={(e) => setRecipeForm({ ...recipeForm, sellingPrice: e.target.value })} />
                </Input>
              </div>
              
              <Input label="Tên món">
                <input className="control" value={recipeForm.productName} onChange={(e) => setRecipeForm({ ...recipeForm, productName: e.target.value })} />
              </Input>
              
              <Input label="Nguyên liệu">
                <ItemSelect items={data.items} value={recipeForm.itemId} onChange={(itemId) => setRecipeForm({ ...recipeForm, itemId })} />
              </Input>
              
              <div className="grid grid-cols-2 gap-3">
                <Input label="Định lượng">
                  <input type="number" step="0.001" className="control" value={recipeForm.quantity} onChange={(e) => setRecipeForm({ ...recipeForm, quantity: e.target.value })} />
                </Input>
                <Input label="Hao hụt %">
                  <input type="number" step="0.1" className="control" value={recipeForm.wasteRate} onChange={(e) => setRecipeForm({ ...recipeForm, wasteRate: e.target.value })} />
                </Input>
              </div>
              
              <button className="primary-button w-full">Lưu phiên bản</button>
            </form>
          )}
          
          <section className="table-panel shadow-sm">
            <Panel title="Cost món theo giá bình quân" reload={loadData} />
            <Table
              headers={[
                { label: "Sản phẩm" },
                { label: "Phiên bản" },
                { label: "Nguyên liệu" },
                { label: "Cost", align: "right" },
                { label: "Giá bán", align: "right" },
                { label: "Tỷ lệ cost", align: "right" },
              ]}
            >
              {data.recipes.map((recipe) => (
                <tr key={recipe.id} className="border-t border-slate-100">
                  <Cell><b>{recipe.productCode} - {recipe.productName}</b></Cell>
                  <Cell>V{recipe.version}</Cell>
                  <Cell>{recipe.lines.map((line) => `${line.item.name}: ${line.quantity} (+${line.wasteRate}%)`).join(", ")}</Cell>
                  <Cell right><b>{money(recipe.estimatedCost)} đ</b></Cell>
                  <Cell right>{money(recipe.sellingPrice)} đ</Cell>
                  <Cell right>{recipe.sellingPrice > 0 ? `${(recipe.estimatedCost / recipe.sellingPrice * 100).toFixed(1)}%` : "-"}</Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "waste" && (
        <div className="max-w-xl">
          <form onSubmit={(e) => { e.preventDefault(); void send({ action: "RECORD_WASTE", ...wasteForm }, "Đã xuất kho nguyên liệu hủy theo định lượng."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 shadow-sm">
            <h2 className="font-bold text-slate-800">Ghi nhận hủy hàng POS</h2>
            
            <Input label="Sản phẩm">
              <select className="control" value={wasteForm.recipeId} onChange={(e) => setWasteForm({ ...wasteForm, recipeId: e.target.value })}>{data.recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.productCode} - {recipe.productName} (V{recipe.version})</option>)}</select>
            </Input>
            
            <Input label="Số lượng hủy">
              <input type="number" min="0.01" step="0.01" className="control" value={wasteForm.productQuantity} onChange={(e) => setWasteForm({ ...wasteForm, productQuantity: e.target.value })} />
            </Input>
            
            <div className="grid grid-cols-2 gap-3">
              <Input label="Chi nhánh">
                <select
                  value={wasteForm.branchCode}
                  onChange={(e) => setWasteForm({ ...wasteForm, branchCode: e.target.value })}
                  className="control"
                >
                  <option value="HCM">CN Hồ Chí Minh</option>
                  <option value="HN">CN Hà Nội</option>
                </select>
              </Input>
              
              <Input label="Kho">
                <select
                  value={wasteForm.warehouseCode}
                  onChange={(e) => setWasteForm({ ...wasteForm, warehouseCode: e.target.value })}
                  className="control"
                >
                  <option value="KHO_HCM">Kho HCM</option>
                  <option value="KHO_HN">Kho HN</option>
                </select>
              </Input>
            </div>
            
            <Input label="Mã giao dịch POS">
              <input data-input-kind="code" className="control" value={wasteForm.referenceCode} onChange={(e) => setWasteForm({ ...wasteForm, referenceCode: e.target.value })} />
            </Input>
            
            <Input label="Ghi chú">
              <textarea className="control h-20 resize-none" value={wasteForm.note} onChange={(e) => setWasteForm({ ...wasteForm, note: e.target.value })} />
            </Input>
            
            <button className="primary-button w-full">
              <span className="material-symbols-outlined text-lg">delete_sweep</span>Ghi nhận hủy
            </button>
          </form>
        </div>
      )}
    </ModuleFrame>
  );
}

function Input({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-bold text-slate-600">{label}{children}</label>; }
function ItemSelect({ items, value, onChange }: { items: Item[]; value: string; onChange: (value: string) => void }) { return <select className="control" value={value} onChange={(e) => onChange(e.target.value)}><option value="">Chọn mặt hàng</option>{items.map((item) => <option key={item.id} value={item.id}>{item.code} - {item.name}</option>)}</select>; }
function Panel({ title, reload }: { title: string; reload: () => void }) { return <div className="p-5 flex justify-between"><h2 className="font-bold text-slate-800">{title}</h2><button type="button" title="Tải lại" onClick={reload} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button></div>; }

function Table({ headers, children }: { headers: { label: string; align?: "left" | "right" }[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200">
          <tr>
            {headers.map((header, i) => (
              <th
                key={i}
                className={`px-4 py-3 font-bold ${header.align === "right" ? "text-right" : "text-left"}`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Cell({ children, right = false }: { children: React.ReactNode; right?: boolean }) { return <td className={`cell ${right ? "text-right" : ""}`}>{children}</td>; }
