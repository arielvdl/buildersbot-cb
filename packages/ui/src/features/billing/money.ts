import type { BillingCurrency } from "@openbot/contracts/billing";
import type { AppFormat } from "@openbot/i18n";

/**
 * A money amount in minor units, with the narrow currency sign as in Add server, and cents only when it
 * has them.
 */
export function formatMinorMoney(format: AppFormat, minor: number, currency: BillingCurrency): string {
  const whole = minor % 100 === 0;
  return format.number(minor / 100, {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
}

/**
 * An amount of a Hub connection, in micros of its currency (millionths of a real), cut down to cents
 * as the Hub contract says. A charge under one cent reads "< R$ 0.01", so a paid call never reads as
 * free.
 */
export function formatConnectionMoney(format: AppFormat, micros: number, currency: string): string {
  const cents = Math.floor(micros / 10_000);
  const options: Intl.NumberFormatOptions = { style: "currency", currency, minimumFractionDigits: 2 };
  if (micros > 0 && cents === 0) return `< ${format.number(0.01, options)}`;
  return format.number(cents / 100, options);
}
