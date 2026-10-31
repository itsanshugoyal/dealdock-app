/** Parse two-decimal money without a binary-float multiplication/rounding step. */
export function parseMoneyInput(value:string):number|null {
  const text=value.trim();
  if(!/^\d+(?:\.\d{1,2})?$/.test(text)||text.length>30)return null;
  const [whole,fraction=""]=text.split(".");
  const minor=BigInt(whole!)*100n+BigInt(fraction.padEnd(2,"0"));
  return minor<=BigInt(Number.MAX_SAFE_INTEGER)?Number(minor):null;
}
export function moneyInputValue(minor:number):string {
  if(!Number.isSafeInteger(minor)||minor<0)throw new Error("Money must be a safe nonnegative integer");
  const value=BigInt(minor);
  return `${value/100n}.${String(value%100n).padStart(2,"0")}`;
}
