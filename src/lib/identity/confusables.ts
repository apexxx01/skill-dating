// Look-alike names. Two names that read the same to a person ("mark" and "rnark", "paypal" and "paypa1", a Latin "admin" and one spelled with
// Cyrillic letters) must not belong to two different people, and nobody may take a look-alike of a reserved name. Pure.
//
// The skeleton of a name is what is left when every difference a reader would not notice is folded away:
//   1. compatibility forms and accents are removed (NFKD), and look-alike letters from other scripts become their Latin twin (Cyrillic а е о р с у х і ј ѕ
//      ԁ ɡ, Greek ο α ε ι κ ν ρ τ υ χ, and others);
//   2. lower case;
//   3. digits and symbols that pass for letters become those letters (0 o, 1 l, 3 e, 4 a, 5 s, 7 t, 8 b, 9 g, | l, $ s, @ a), and i becomes l;
//   4. separators (_ - . and spaces) are dropped;
//   5. letter pairs that pass for one letter are folded, in this order: rn to m, vv to w, cl to d.
// Two names are confusable when their skeletons are equal. Steps 2 to 5 on an ASCII username are exactly what the migration that filled
// User.usernameSkeleton does in SQL (20261021000600_identity), so the stored skeletons and this function agree.

const SCRIPT_LOOKALIKES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', і: 'i', ї: 'i', ј: 'j', ԁ: 'd',
  ԛ: 'q', ԝ: 'w', ӏ: 'l', һ: 'h', ү: 'y', ɡ: 'g', ı: 'i',
  А: 'a', В: 'b', Е: 'e', К: 'k', М: 'm', Н: 'h', О: 'o', Р: 'p', С: 'c', Т: 't', У: 'y', Х: 'x', Ѕ: 's', І: 'i', Ј: 'j',
  // Greek
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  Α: 'a', Β: 'b', Ε: 'e', Η: 'h', Ι: 'i', Κ: 'k', Μ: 'm', Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't', Υ: 'y', Χ: 'x', Ζ: 'z',
  // Latin look-alikes outside ASCII that NFKD does not fold
  ł: 'l', ø: 'o', đ: 'd', ħ: 'h', ŀ: 'l', ß: 'ss', æ: 'ae', œ: 'oe',
}

const ASCII_LOOKALIKES: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '|': 'l', $: 's', '@': 'a', i: 'l' }

export function skeleton(text: string): string {
  const folded = [...text.normalize('NFKD').replace(/[̀-ͯ]/g, '')].map((ch) => SCRIPT_LOOKALIKES[ch] ?? ch).join('').toLowerCase()
  const mapped = [...folded].map((ch) => ASCII_LOOKALIKES[ch] ?? ch).join('')
  return mapped
    .replace(/[_.\-\s]/g, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/cl/g, 'd')
}

export function areConfusable(a: string, b: string): boolean {
  return skeleton(a) === skeleton(b)
}

/** Whether the text uses letters from more than one script (Latin mixed with Cyrillic or Greek): a common trick to imitate a name. */
export function mixesScripts(text: string): boolean {
  const latin = /[A-Za-z]/.test(text)
  const cyrillic = /\p{Script=Cyrillic}/u.test(text)
  const greek = /\p{Script=Greek}/u.test(text)
  return [latin, cyrillic, greek].filter(Boolean).length > 1
}
