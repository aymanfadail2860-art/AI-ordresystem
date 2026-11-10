import type { Db } from '../db/database';
import { nowIso, parseJson } from '../db/database';
import type { Bus } from '../infra';
import type { Product } from '../../shared/types';

export interface ProductInput {
  sku: string;
  name: string;
  category: string;
  variant?: string | null;
  priceOre: number;
  costOre?: number | null;
  active?: boolean;
  description?: string | null;
  synonyms?: string[];
  /** Lagerenheder pr. stk. (standard 1). */
  unitVolume?: number;
}

export function mapProduct(r: Record<string, unknown>): Product {
  return {
    id: r.id as number,
    sku: r.sku as string,
    name: r.name as string,
    category: r.category as string,
    variant: (r.variant as string) ?? null,
    priceOre: r.price_ore as number,
    costOre: (r.cost_ore as number) ?? null,
    active: !!r.active,
    description: (r.description as string) ?? null,
    synonyms: parseJson<string[]>(r.synonyms as string, []),
    unitVolume: (r.unit_volume as number) ?? 1,
  };
}

export class CatalogService {
  constructor(
    private db: Db,
    private bus: Bus,
  ) {}

  list(opts: { includeInactive?: boolean } = {}): Product[] {
    const rows = this.db
      .prepare(`SELECT * FROM products ${opts.includeInactive ? '' : 'WHERE active = 1'} ORDER BY category, name`)
      .all() as Record<string, unknown>[];
    return rows.map(mapProduct);
  }

  get(id: number): Product | null {
    const r = this.db.prepare(`SELECT * FROM products WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? mapProduct(r) : null;
  }

  getBySku(sku: string): Product | null {
    const r = this.db.prepare(`SELECT * FROM products WHERE sku = ? COLLATE NOCASE`).get(sku) as
      | Record<string, unknown>
      | undefined;
    return r ? mapProduct(r) : null;
  }

  validate(p: ProductInput): void {
    if (!p.sku?.trim()) throw new Error('Varenummer (SKU) mangler');
    if (!/^[A-Za-z0-9_\-]{1,40}$/.test(p.sku.trim())) throw new Error('SKU må kun indeholde bogstaver, tal, - og _');
    if (!p.name?.trim()) throw new Error('Produktnavn mangler');
    if (!Number.isInteger(p.priceOre) || p.priceOre < 0 || p.priceOre > 10_000_000) throw new Error('Ugyldig pris');
    if (p.costOre != null && (!Number.isInteger(p.costOre) || p.costOre < 0 || p.costOre > 10_000_000)) throw new Error('Ugyldig vareomkostning');
    if (p.unitVolume != null && (!Number.isFinite(p.unitVolume) || p.unitVolume <= 0 || p.unitVolume > 1000)) throw new Error('Ugyldig pladsangivelse (lagerenheder)');
  }

  create(p: ProductInput): Product {
    this.validate(p);
    const r = this.db
      .prepare(
        `INSERT INTO products (sku, name, category, variant, price_ore, cost_ore, active, description, synonyms, unit_volume)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.sku.trim().toUpperCase(),
        p.name.trim(),
        p.category?.trim() || 'Andet',
        p.variant ?? null,
        p.priceOre,
        p.costOre ?? null,
        p.active === false ? 0 : 1,
        p.description ?? null,
        JSON.stringify(cleanSynonyms(p.synonyms)),
        p.unitVolume ?? 1,
      );
    this.bus.touch('products');
    return this.get(Number(r.lastInsertRowid))!;
  }

  update(id: number, p: ProductInput): Product {
    this.validate(p);
    this.db
      .prepare(
        `UPDATE products SET sku = ?, name = ?, category = ?, variant = ?, price_ore = ?, cost_ore = ?, active = ?,
         description = ?, synonyms = ?, unit_volume = COALESCE(?, unit_volume), updated_at = ? WHERE id = ?`,
      )
      .run(
        p.sku.trim().toUpperCase(),
        p.name.trim(),
        p.category?.trim() || 'Andet',
        p.variant ?? null,
        p.priceOre,
        p.costOre ?? null,
        p.active === false ? 0 : 1,
        p.description ?? null,
        JSON.stringify(cleanSynonyms(p.synonyms)),
        p.unitVolume ?? null,
        nowIso(),
        id,
      );
    this.bus.touch('products');
    return this.get(id)!;
  }

  setActive(id: number, active: boolean): void {
    this.db.prepare(`UPDATE products SET active = ?, updated_at = ? WHERE id = ?`).run(active ? 1 : 0, nowIso(), id);
    this.bus.touch('products');
  }
}

function cleanSynonyms(s?: string[]): string[] {
  return [...new Set((s ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}
