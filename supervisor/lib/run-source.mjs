export const isLocalRun = (run) => ['perf', 'bench-tick'].includes(run?.kind);

/** Проверяется без диска: принимающая станция может отличаться от исполняющей. */
export function runSourceProblem(run) {
  if (!isLocalRun(run)) return null;
  const source = run?.params?.source;
  const prefix = 'run.params.source';
  if (!source || typeof source !== 'object' || Array.isArray(source))
    return `${prefix}: требуется объект с branch или worktree`;
  const keys = Object.keys(source);
  if (keys.length !== 1 || !['branch', 'worktree'].includes(keys[0]))
    return `${prefix}: требуется ровно один ключ branch или worktree`;
  const value = source[keys[0]];
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return `${prefix}.${keys[0]}: требуется непустая строка без краевых пробелов и управляющих символов`;
  if (
    keys[0] === 'branch' &&
    (value === 'HEAD' ||
      value === '@' ||
      /^(refs|origin)\//.test(value) ||
      /^[a-f0-9]{40,64}$/i.test(value) ||
      value.startsWith('-') ||
      /[ ~^:?*[\\]/.test(value) ||
      value.includes('..') ||
      value.includes('@{') ||
      value
        .split('/')
        .some(
          (part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'),
        ))
  )
    return `${prefix}.branch: требуется короткое имя локальной ветки`;
  if (keys[0] === 'worktree' && /^[\\/]{2}/.test(value))
    return `${prefix}.worktree: UNC не поддерживается`;
  return null;
}
