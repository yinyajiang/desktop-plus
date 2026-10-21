import { getStringArray, setStringArray } from '../local-storage'
import { migrateRepositoryGroupKey } from '../../ui/repositories-list/group-repositories'

const RepositoryGroupOrderKey = 'repository-group-order'

/**
 * The keys of the repository list groups in the order chosen by the user, or
 * an empty array if the groups are in their default order.
 */
export function getRepositoryGroupOrder(): ReadonlyArray<string> {
  return getStringArray(RepositoryGroupOrderKey).map(migrateRepositoryGroupKey)
}

/** Saves the order of the repository list groups chosen by the user. */
export function setRepositoryGroupOrder(order: ReadonlyArray<string>) {
  setStringArray(RepositoryGroupOrderKey, order)
}

/** Forgets the saved group order, going back to the default one. */
export function resetRepositoryGroupOrder() {
  localStorage.removeItem(RepositoryGroupOrderKey)
}

/**
 * Makes a renamed group keep the position of the group it used to be.
 */
export function renameRepositoryGroupInOrder(
  oldKey: string,
  newKey: string,
  newGroupExists: boolean
) {
  const order = getRepositoryGroupOrder()
  const renamed = renameKeyInGroupOrder(order, oldKey, newKey, newGroupExists)

  if (
    renamed.length !== order.length ||
    renamed.some((key, i) => key !== order[i])
  ) {
    setRepositoryGroupOrder(renamed)
  }
}

/**
 * Returns the group order resulting from renaming the group with oldKey to
 * newKey. See renameRepositoryGroupInOrder.
 */
export function renameKeyInGroupOrder(
  order: ReadonlyArray<string>,
  oldKey: string,
  newKey: string,
  newGroupExists: boolean
): ReadonlyArray<string> {
  if (oldKey === newKey) {
    return order
  }

  if (newGroupExists && order.includes(newKey)) {
    return order.filter(key => key !== oldKey)
  }

  return order
    .filter(key => key !== newKey)
    .map(key => (key === oldKey ? newKey : key))
}
