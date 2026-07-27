// Money helpers. Provider amounts are integer minor units (cents).

export function fmtMoney(minor, currency = "EUR", locale = "en-IE") {
  const value = minor / 100;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function fmtPercent(n) {
  return `${Math.round(n * 100) / 100}%`;
}
