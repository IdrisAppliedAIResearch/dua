export const state = {
  entries: [],
  mode: "closed",
  spread: 0,
  editing: null,
  offline: false,
};

export function sortEntries() {
  state.entries.sort((a, b) => {
    if (!a.date !== !b.date) return a.date ? 1 : -1;
    return a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1;
  });
}

export function findEntry(id) {
  return state.entries.find((e) => e.id === id) || null;
}
