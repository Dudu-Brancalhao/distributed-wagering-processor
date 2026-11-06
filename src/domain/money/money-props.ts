/** Contract representation of an amount: a decimal string with exactly two decimals and an ISO-4217 code. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}
