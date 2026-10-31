import {expect,it} from "vitest";
import {moneyInputValue,parseMoneyInput} from "../src/money-input";
it.each([["1200.50",120050],["0.01",1],["0",0],["1.1",110],["90071992547409.91",Number.MAX_SAFE_INTEGER]])("parses exact minor units for %s",(input,expected)=>expect(parseMoneyInput(input)).toBe(expected));
it.each(["1.005","1e3","-1","1,200","NaN","","90071992547409.92"])("rejects invalid or unsafe money %s",input=>expect(parseMoneyInput(input)).toBeNull());
it.each([120050,1,0,Number.MAX_SAFE_INTEGER])("round-trips editable money %s without losing cents",minor=>expect(parseMoneyInput(moneyInputValue(minor))).toBe(minor));
