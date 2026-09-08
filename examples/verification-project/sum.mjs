// Deliberately incomplete demo task: sum([]) should return 0.
export function sum(values) {
  return values.reduce((total, value) => total + value);
}
