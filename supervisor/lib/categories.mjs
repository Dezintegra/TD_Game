export const CATEGORIES = ['ux', 'mechanics', 'balance', 'infrastructure'];

export function categoriesProblem(value, required = false) {
  if (value === undefined && !required) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => !CATEGORIES.includes(item)) ||
    new Set(value).size !== value.length
  )
    return `categories: нужен непустой список без повторов из ${CATEGORIES.join(', ')}`;
  return null;
}

// Эти поля принадлежат протоколу ожидания, а не колонке или меткам Trello.
export const ROUTING_FIELDS = ['creationKey', 'blockedContext', 'reanalysis', 'analysisGeneration'];
export function routingFields(value) {
  return Object.fromEntries(
    ROUTING_FIELDS.filter((key) => Object.hasOwn(value ?? {}, key)).map((key) => [key, value[key]]),
  );
}
