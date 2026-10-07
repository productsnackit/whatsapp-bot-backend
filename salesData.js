/* =========================================================
    SALE DATA
    What the vending machines sold, from the Wendor reports uploaded in Live Stock (stock_sales:
    completed vends per 10 minutes, machine, slot and product). For a period (and one location
    or all): sales value and units against the period just before it of the same length, day by
    day, month by month, by location, product, machine, hour of day and weekday. Product names
    are shown as in the Product List. Value = the amount Wendor recorded for the sale.
========================================================= */
import XLSX from "xlsx";
import { hasPage } from "./accessControl.js";
import { productNamer } from "./locationStock.js";

let db = null;
const IST = 330 * 60000;
const istDay = (date = new Date()) => new Date(new Date(date).getTime() + IST).toISOString().slice(0, 10);
const addDays = (date, days) => { const day = new Date(`${date}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + days); return day.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000) + 1;
const weekday = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon = 0
const round = (value) => Math.round(value);
// The same date a month earlier (31 Oct → 30 Sep).
function monthBefore(date) {
  const [y, m, d] = date.split("-").map(Number);
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function ensureSalesData(database) {
  db = database;
}

// compare: "previous" = the days just before, same length; "month" = the same dates last month.
async function overview({ from, to, locationId, compare = "previous" }) {
  const { rows: span } = await db.query("SELECT MIN(day)::text AS first, MAX(day)::text AS last FROM stock_sales").catch(() => ({ rows: [{}] }));
  const first = span[0]?.first || null;
  const last = span[0]?.last || null;
  // A period running past the last uploaded day is compared only up to that day (5 days of sales
  // against 5 days, not against 7).
  const asked = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : last || istDay();
  const end = last && asked > last && (!from || from <= last) ? last : asked;
  const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : first || end;
  const days = Math.max(1, daysBetween(start, end));
  const byMonth = compare === "month";
  const prevTo = byMonth ? monthBefore(end) : addDays(start, -1);
  const prevFrom = byMonth ? monthBefore(start) : addDays(start, -days);

  const { rows: machines } = await db.query(
    "SELECT m.id, m.name, m.location_id, l.name AS location_name FROM stock_machines m LEFT JOIN audit_locations l ON l.id = m.location_id ORDER BY m.name"
  );
  const machineOf = new Map(machines.map((machine) => [machine.id, machine]));
  const chosen = Number(locationId) ? machines.filter((machine) => machine.location_id === Number(locationId)).map((machine) => machine.id) : null;
  const where = chosen ? "AND machine_id = ANY($3)" : "";
  const params = chosen ? [prevFrom, end, chosen] : [prevFrom, end];
  const inPrev = (day) => day >= prevFrom && day <= prevTo;
  const { rows } = await db.query(
    `SELECT day::text AS day, (bucket / 6)::int AS hour, machine_id, product, SUM(qty)::int AS qty, SUM(amount)::float AS amount
     FROM stock_sales WHERE day BETWEEN $1 AND $2 ${where} GROUP BY day, hour, machine_id, product`,
    params
  );
  const nameOf = await productNamer();
  const placeKey = (machine) => (machine?.location_id ? `l${machine.location_id}` : `m${machine?.id}`);
  const placeName = (machine) => machine?.location_name || `${machine?.name || "Machine"} (not linked)`;

  const empty = () => ({ units: 0, value: 0 });
  const add = (target, row) => { target.units += row.qty; target.value += row.amount; };
  const totals = empty();
  const prev = empty();
  const daily = new Map();
  const prevDaily = new Map();
  const places = new Map();
  const products = new Map();
  const machinesSold = new Map();
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, ...empty() }));
  const weekdays = Array.from({ length: 7 }, (_, day) => ({ day, ...empty(), dates: new Set() }));
  const activeMachines = new Set();
  const salesDays = new Set();
  for (const row of rows) {
    const machine = machineOf.get(row.machine_id);
    const current = row.day >= start;
    if (!current && !inPrev(row.day)) continue;
    const key = placeKey(machine);
    if (!places.has(key)) places.set(key, { key, id: machine?.location_id || null, name: placeName(machine), ...empty(), prev_units: 0, prev_value: 0, machines: new Set(), products: new Map(), days: new Set() });
    const place = places.get(key);
    const product = nameOf(row.product);
    if (!products.has(product)) products.set(product, { name: product, ...empty(), prev_units: 0, prev_value: 0 });
    if (!machinesSold.has(row.machine_id)) machinesSold.set(row.machine_id, { id: row.machine_id, name: machine?.name || "Machine", location: placeName(machine), ...empty(), prev_units: 0, prev_value: 0 });
    if (current) {
      add(totals, row);
      if (!daily.has(row.day)) daily.set(row.day, empty());
      add(daily.get(row.day), row);
      add(place, row);
      place.machines.add(row.machine_id);
      place.days.add(row.day);
      place.products.set(product, (place.products.get(product) || 0) + row.qty);
      add(products.get(product), row);
      add(machinesSold.get(row.machine_id), row);
      add(hours[row.hour] || hours[0], row);
      const wd = weekdays[weekday(row.day)];
      add(wd, row);
      wd.dates.add(row.day);
      activeMachines.add(row.machine_id);
      salesDays.add(row.day);
    } else {
      add(prev, row);
      if (!prevDaily.has(row.day)) prevDaily.set(row.day, empty());
      add(prevDaily.get(row.day), row);
      place.prev_units += row.qty;
      place.prev_value += row.amount;
      products.get(product).prev_units += row.qty;
      products.get(product).prev_value += row.amount;
      machinesSold.get(row.machine_id).prev_units += row.qty;
      machinesSold.get(row.machine_id).prev_value += row.amount;
    }
  }
  const prevDays = new Set([...prevDaily.keys()]);

  // Day by day, each day next to the same day of the period before.
  const series = [];
  for (let index = 0; index < days; index += 1) {
    const date = addDays(start, index);
    const before = addDays(prevFrom, index);
    const today = daily.get(date) || empty();
    const then = prevDaily.get(before) || empty();
    series.push({ date, units: today.units, value: round(today.value), prev_date: before, prev_units: then.units, prev_value: round(then.value), has_data: Boolean(last && date <= last) });
  }

  // Month by month over everything uploaded (for this location, or all).
  const { rows: monthRows } = await db.query(
    `SELECT to_char(day, 'YYYY-MM') AS month, SUM(qty)::int AS units, SUM(amount)::float AS value, COUNT(DISTINCT day)::int AS days
     FROM stock_sales ${chosen ? "WHERE machine_id = ANY($1)" : ""} GROUP BY month ORDER BY month`,
    chosen ? [chosen] : []
  );

  const best = [...daily.entries()].sort((a, b) => b[1].value - a[1].value)[0];
  const sum = (object) => ({ units: object.units, value: round(object.value) });
  return {
    range: { from: start, to: end, days, asked_to: asked },
    previous: { from: prevFrom, to: prevTo, has_data: prevDays.size > 0, compare: byMonth ? "month" : "previous" },
    data: { first, last },
    totals: {
      ...sum(totals), sales_days: salesDays.size, machines: activeMachines.size,
      locations: [...places.values()].filter((place) => place.units > 0).length,
      per_day: salesDays.size ? round(totals.value / salesDays.size) : 0,
      units_per_day: salesDays.size ? Math.round((totals.units / salesDays.size) * 10) / 10 : 0,
      avg_price: totals.units ? Math.round((totals.value / totals.units) * 10) / 10 : 0,
      best_day: best ? { date: best[0], value: round(best[1].value), units: best[1].units } : null,
    },
    prev_totals: { ...sum(prev), sales_days: prevDays.size, per_day: prevDays.size ? round(prev.value / prevDays.size) : 0, avg_price: prev.units ? Math.round((prev.value / prev.units) * 10) / 10 : 0 },
    daily: series,
    months: monthRows.map((month) => ({ month: month.month, units: month.units, value: round(month.value), days: month.days })),
    locations: [...places.values()].filter((place) => place.units || place.prev_units).map((place) => {
      const top = [...place.products.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        id: place.id, name: place.name, units: place.units, value: round(place.value), prev_units: place.prev_units, prev_value: round(place.prev_value),
        machines: place.machines.size, per_day: place.days.size ? round(place.value / place.days.size) : 0, top_product: top ? { name: top[0], units: top[1] } : null,
      };
    }).sort((a, b) => b.value - a.value),
    products: [...products.values()].filter((product) => product.units || product.prev_units).map((product) => ({ ...product, value: round(product.value), prev_value: round(product.prev_value) })).sort((a, b) => b.value - a.value),
    machines: [...machinesSold.values()].filter((machine) => machine.units || machine.prev_units).map((machine) => ({ ...machine, value: round(machine.value), prev_value: round(machine.prev_value) })).sort((a, b) => b.value - a.value),
    hours: hours.map((hour) => ({ hour: hour.hour, units: hour.units, value: round(hour.value) })),
    weekdays: weekdays.map((day) => ({ day: day.day, units: day.units, value: round(day.value), dates: day.dates.size, per_day: day.dates.size ? round(day.value / day.dates.size) : 0 })),
    location_options: [...new Map(machines.filter((machine) => machine.location_id).map((machine) => [machine.location_id, { id: machine.location_id, name: machine.location_name }])).values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function registerSalesDataRoutes(app, { auth }) {
  const guard = (req, res, next) => (hasPage(req.user, "sales_data") ? next() : res.status(403).json({ error: "No access to Sale Data" }));
  const handle = (label, fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) { console.log(`${label} ERROR:`, err.message); res.status(500).json({ error: "Server error" }); }
  };
  // Kept a few minutes per filter (new uploads change it; the page has Refresh).
  const kept = new Map();
  const cached = async (query) => {
    const key = JSON.stringify([query.from, query.to, query.location_id, query.compare]);
    const { rows } = await db.query("SELECT COALESCE(MAX(uploaded_at)::text, '') AS last FROM stock_uploads").catch(() => ({ rows: [{ last: "" }] }));
    const hit = kept.get(key);
    if (hit && hit.stamp === rows[0].last && Date.now() - hit.at < 5 * 60000) return hit.value;
    const value = await overview({ from: query.from, to: query.to, locationId: query.location_id, compare: query.compare });
    kept.set(key, { stamp: rows[0].last, at: Date.now(), value });
    if (kept.size > 40) kept.delete(kept.keys().next().value);
    return value;
  };

  app.get("/saledata/overview", auth, guard, handle("SALE DATA", async (req, res) => {
    res.json(await cached(req.query));
  }));

  // Excel: day by day, locations, products and machines for the filter shown.
  app.get("/saledata/export", auth, guard, handle("SALE DATA EXPORT", async (req, res) => {
    const data = await cached(req.query);
    const book = XLSX.utils.book_new();
    const sheet = (name, rows) => XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
    const change = (now, then) => (then ? `${Math.round(((now - then) / then) * 100)}%` : "");
    sheet("Day by day", [["Date", "Units", "Sales ₹", "Same day before", "Units before", "Sales ₹ before"], ...data.daily.map((day) => [day.date, day.units, day.value, day.prev_date, day.prev_units, day.prev_value])]);
    sheet("Locations", [["Location", "Machines", "Units", "Sales ₹", "Sales ₹ before", "Change", "₹ per day", "Top product"], ...data.locations.map((place) => [place.name, place.machines, place.units, place.value, place.prev_value, change(place.value, place.prev_value), place.per_day, place.top_product?.name || ""])]);
    sheet("Products", [["Product", "Units", "Sales ₹", "Units before", "Sales ₹ before", "Change"], ...data.products.map((product) => [product.name, product.units, product.value, product.prev_units, product.prev_value, change(product.value, product.prev_value)])]);
    sheet("Machines", [["Machine", "Location", "Units", "Sales ₹", "Sales ₹ before", "Change"], ...data.machines.map((machine) => [machine.name, machine.location, machine.units, machine.value, machine.prev_value, change(machine.value, machine.prev_value)])]);
    sheet("Months", [["Month", "Days with sales", "Units", "Sales ₹"], ...data.months.map((month) => [month.month, month.days, month.units, month.value])]);
    const place = data.location_options.find((option) => String(option.id) === String(req.query.location_id))?.name;
    res.json({ name: `Sale data ${place ? `${place} ` : ""}${data.range.from} to ${data.range.to}.xlsx`, data: XLSX.write(book, { type: "base64", bookType: "xlsx" }) });
  }));
}
