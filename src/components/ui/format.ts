export function formatMoney(value: string | number, currency = "USD") {
  const n = typeof value === "string" ? Number(value) : value;
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

export function formatClock(d: Date) {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function formatDay(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? "Good evening." : h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
}
