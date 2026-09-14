function valuesEqual(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => valuesEqual(value, right[index]));
  }
  return Object.is(left, right);
}

export function targetMatchesSnapshot(snapshot, current, fields) {
  return current !== null && fields.every((field) => valuesEqual(snapshot[field], current[field]));
}
