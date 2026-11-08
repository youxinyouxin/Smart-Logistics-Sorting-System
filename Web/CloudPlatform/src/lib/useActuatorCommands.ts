import { useCallback, useRef, useState } from 'react'
import { errorMessage, getDoChannel, setDoChannel } from './api'

type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface ActuatorAction {
  channel: number
  value: boolean
}

interface ExecuteOptions {
  key: string
  successMessage: string
  failureMessage: string
}

interface UseActuatorCommandsOptions {
  base: string
  doMap: Record<string, boolean>
  updateChannel: (channel: number, value: boolean) => void
  showToast: (message: string, type?: ToastKind) => void
}

const VERIFY_DELAY_MS = 900

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function useActuatorCommands({
  base,
  doMap,
  updateChannel,
  showToast,
}: UseActuatorCommandsOptions) {
  const [overrides, setOverrides] = useState<Record<number, boolean>>({})
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const pendingRef = useRef<Set<string>>(new Set())

  const channelValue = useCallback(
    (channel: number): boolean | undefined => {
      const override = overrides[channel]
      if (typeof override === 'boolean') return override
      const value = doMap[`DO${channel}`]
      return typeof value === 'boolean' ? value : undefined
    },
    [doMap, overrides],
  )

  const isPending = useCallback((key: string) => Boolean(pending[key]), [pending])

  const execute = useCallback(
    async (actions: ActuatorAction[], options: ExecuteOptions) => {
      if (!actions.length || pendingRef.current.has(options.key)) return
      pendingRef.current.add(options.key)
      setPending((previous) => ({ ...previous, [options.key]: true }))
      setOverrides((previous) => {
        const next = { ...previous }
        for (const action of actions) next[action.channel] = action.value
        return next
      })

      let postError: unknown = null
      for (const action of actions) {
        try {
          await setDoChannel(base, action.channel, action.value)
        } catch (error) {
          postError = error
          break
        }
      }

      await wait(VERIFY_DELAY_MS)

      const channels = Array.from(new Set(actions.map((action) => action.channel)))
      const verified = new Map<number, boolean>()
      let verifyError: unknown = null
      for (const channel of channels) {
        try {
          const result = await getDoChannel(base, channel)
          verified.set(channel, result.value)
        } catch (error) {
          verifyError = error
        }
      }

      for (const [channel, value] of verified) updateChannel(channel, value)
      setOverrides((previous) => {
        const next = { ...previous }
        for (const channel of channels) delete next[channel]
        return next
      })
      pendingRef.current.delete(options.key)
      setPending((previous) => {
        const next = { ...previous }
        delete next[options.key]
        return next
      })

      const success =
        postError === null &&
        verifyError === null &&
        actions.every((action) => verified.get(action.channel) === action.value)

      if (success) {
        showToast(options.successMessage, 'success')
        return
      }

      const detail = postError
        ? errorMessage(postError)
        : verifyError
          ? errorMessage(verifyError)
          : '状态核对未通过'
      showToast(`${options.failureMessage}：${detail}`, 'error')
    },
    [base, showToast, updateChannel],
  )

  return { channelValue, isPending, execute }
}
