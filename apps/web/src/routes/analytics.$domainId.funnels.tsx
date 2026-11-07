import { useState } from 'react'
import { IconFilter, IconPlus, IconTrash } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ReportCard } from '../components/analytics-report'
import {
	Button,
	Confirm,
	EmptyState,
	ErrorText,
	ListPlaceholder,
	Field,
	FormDialog,
	IconButton,
	Input,
	Section,
	Select,
} from '../components/primitives'
import { type AnalyticsFunnel, type FunnelStep, api } from '../lib/api'
import { percent } from '../lib/format'
import { useSpan } from './analytics.$domainId'

export const Route = createFileRoute('/analytics/$domainId/funnels')({ component: Funnels })

const stepKinds = [
	{ value: 'page', label: 'Page' },
	{ value: 'goal', label: 'Goal' },
	{ value: 'payment', label: 'Payment' },
] as const satisfies readonly { value: FunnelStep['kind']; label: string }[]

function stepName(step: FunnelStep) {
	if (step.kind === 'payment') return 'Paid'
	return step.kind === 'goal' ? `Goal ${step.value}` : step.value
}

function Funnels() {
	const { domainId } = Route.useParams()
	const { span } = useSpan()
	const queryClient = useQueryClient()
	const [open, setOpen] = useState(false)
	const funnels = useQuery({
		queryKey: ['analytics', domainId, 'funnels', span],
		queryFn: () => api.analyticsFunnels(domainId, span),
		placeholderData: keepPreviousData,
	})
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteFunnel(domainId, id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['analytics', domainId, 'funnels'] }),
	})
	const data = funnels.data ?? []

	return (
		<Section
			title='Funnels'
			total={funnels.data?.length}
			actions={
				<Button variant='primary' size='sm' onClick={() => setOpen(true)}>
					<IconPlus size={16} stroke={1.75} />
					Add funnel
				</Button>
			}
		>
			<ErrorText error={remove.error} />
			<ErrorText error={funnels.error} />
			{data.length > 0 ? (
				<div className='flex flex-col gap-4'>
					{data.map(funnel => (
						<FunnelCard
							key={funnel.id}
							funnel={funnel}
							onDelete={() => remove.mutate(funnel.id)}
							removing={remove.isPending ? remove.variables : undefined}
						/>
					))}
				</div>
			) : funnels.error ? null : (
				<ListPlaceholder loading={funnels.isPending} label='Loading funnels' lines={4}>
					<EmptyState
						icon={IconFilter}
						title='No funnels yet'
						description='A funnel counts how many visitors reach each step in order: a page, a goal, a payment. Add funnel defines one.'
					/>
				</ListPlaceholder>
			)}
			<AddFunnel domainId={domainId} open={open} onOpenChange={setOpen} />
		</Section>
	)
}

function FunnelCard({
	funnel,
	onDelete,
	removing,
}: {
	funnel: AnalyticsFunnel
	onDelete: () => void
	/** The funnel a delete is in flight for, if any. */
	removing: string | undefined
}) {
	const first = Math.max(funnel.reached[0] ?? 0, 1)
	return (
		<ReportCard
			title={funnel.name}
			level={3}
			actions={
				<Confirm
					title={`Delete the ${funnel.name} funnel?`}
					description='The visits it counted stay recorded; only this report goes.'
					action='Delete funnel'
					onConfirm={onDelete}
				>
					<IconButton
						label={`Delete the ${funnel.name} funnel`}
						icon={IconTrash}
						loading={removing === funnel.id}
						disabled={removing !== undefined}
					/>
				</Confirm>
			}
		>
			<div aria-hidden className='flex justify-end gap-6 px-2 text-xs text-muted'>
				<span className='w-16 text-right'>Reached</span>
				{/* At 390 px three columns leave the step name about 36 px; the share of step 1 goes first. */}
				<span className='hidden w-16 text-right sm:block'>Of step 1</span>
				<span className='w-20 text-right'>Drop</span>
			</div>
			<ol className='flex flex-col gap-1'>
				{funnel.steps.map((step, index) => {
					const reached = funnel.reached[index] ?? 0
					const before = index === 0 ? reached : (funnel.reached[index - 1] ?? 0)
					const drop = index === 0 || before === 0 ? null : ((before - reached) / before) * 100
					return (
						<li
							// A funnel may repeat a step, and its order never changes, so the position is the identity.
							key={index}
							className='relative flex items-center justify-between gap-4 px-2 py-1.5 text-sm'
						>
							<span
								aria-hidden
								className='absolute inset-y-0 left-0 rounded-[calc(var(--radius-control)-4px)] bg-accent/12'
								style={{ width: `${(reached / first) * 100}%` }}
							/>
							<span className='relative min-w-0 wrap-anywhere'>
								{index + 1}. {stepName(step)}
							</span>
							<span className='relative flex shrink-0 gap-6 tabular-nums'>
								<span className='w-16 text-right'>
									{reached.toLocaleString('en-US')}
									<span className='sr-only'> reached</span>
								</span>
								<span className='hidden w-16 text-right text-muted sm:block'>
									{percent((reached / first) * 100)}
									<span className='sr-only'> of step 1</span>
								</span>
								<span className='w-20 text-right text-muted'>
									{drop === null ? null : (
										<>
											-{percent(drop)}
											<span className='sr-only'> lost from the step before</span>
										</>
									)}
								</span>
							</span>
						</li>
					)
				})}
			</ol>
		</ReportCard>
	)
}

const stepPlaceholder = { page: '/pricing', goal: 'signup', payment: 'any payment' } as const

let stepCount = 0
/** A step in the dialog: its `id` keys the row, so removing a middle step leaves every other row its own Select and focus. */
function draftStep(kind: FunnelStep['kind'], value: string) {
	stepCount += 1
	return { id: stepCount, kind, value }
}

const blankSteps = () => [draftStep('page', '/'), draftStep('goal', '')]

function AddFunnel({
	domainId,
	open,
	onOpenChange,
}: {
	domainId: string
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const queryClient = useQueryClient()
	const [name, setName] = useState('')
	const [steps, setSteps] = useState(blankSteps)
	const create = useMutation({
		mutationFn: () =>
			api.createFunnel(domainId, { name, steps: steps.map(({ kind, value }) => ({ kind, value })) }),
		onSuccess: () => {
			onOpenChange(false)
			setName('')
			setSteps(blankSteps())
			void queryClient.invalidateQueries({ queryKey: ['analytics', domainId, 'funnels'] })
		},
	})
	const change = (index: number, patch: Partial<FunnelStep>) =>
		setSteps(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)))

	return (
		<FormDialog
			open={open}
			onOpenChange={next => {
				onOpenChange(next)
				if (next) return
				setName('')
				setSteps(blankSteps())
			}}
			title='Add a funnel'
			description='Two to eight steps. A page ending in * matches every path under it.'
			action='Add funnel'
			icon={IconPlus}
			mutation={create}
			onSubmit={() => create.mutate()}
			wide
		>
			<Field label='Name'>
				<Input value={name} maxLength={64} required onChange={event => setName(event.target.value)} />
			</Field>
			<div className='flex flex-col gap-3'>
				{steps.map((step, index) => (
					<div key={step.id} className='flex items-center gap-2'>
						<span className='w-5 text-sm text-muted tabular-nums'>{index + 1}.</span>
						<Select
							label={`Step ${index + 1} kind`}
							className='w-32'
							value={step.kind}
							options={stepKinds}
							onChange={kind => change(index, { kind, value: kind === 'payment' ? '' : step.value })}
						/>
						<div className='flex-1'>
							<Input
								aria-label={`Step ${index + 1} value`}
								mono
								disabled={step.kind === 'payment'}
								required={step.kind !== 'payment'}
								placeholder={stepPlaceholder[step.kind]}
								value={step.value}
								onChange={event => change(index, { value: event.target.value })}
							/>
						</div>
						<IconButton
							label={`Remove step ${index + 1}`}
							icon={IconTrash}
							disabled={steps.length <= 2}
							onClick={() => setSteps(steps.filter((_, i) => i !== index))}
						/>
					</div>
				))}
				<div>
					<Button disabled={steps.length >= 8} onClick={() => setSteps([...steps, draftStep('goal', '')])}>
						<IconPlus size={16} stroke={1.75} />
						Add step
					</Button>
				</div>
			</div>
		</FormDialog>
	)
}
