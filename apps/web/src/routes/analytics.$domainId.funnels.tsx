import { useState } from 'react'
import { IconFilter, IconPlus, IconTrash } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
	Button,
	Confirm,
	EmptyState,
	ErrorText,
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
			total={data.length}
			actions={
				<Button onClick={() => setOpen(true)}>
					<IconPlus size={16} stroke={1.75} />
					Add funnel
				</Button>
			}
		>
			<ErrorText error={funnels.error ?? remove.error} />
			{funnels.isSuccess && data.length === 0 ? (
				<div className='rounded-surface border bg-surface'>
					<EmptyState
						icon={IconFilter}
						title='No funnels yet'
						description='A funnel counts how many visitors reach each step in order: a page, a goal, a payment.'
					/>
				</div>
			) : null}
			<div className='flex flex-col gap-4'>
				{data.map(funnel => (
					<FunnelCard key={funnel.id} funnel={funnel} onDelete={() => remove.mutate(funnel.id)} />
				))}
			</div>
			<AddFunnel domainId={domainId} open={open} onOpenChange={setOpen} />
		</Section>
	)
}

function FunnelCard({ funnel, onDelete }: { funnel: AnalyticsFunnel; onDelete: () => void }) {
	const first = Math.max(funnel.reached[0] ?? 0, 1)
	return (
		<section className='rounded-surface border bg-surface p-4'>
			<header className='mb-3 flex h-8 items-center justify-between gap-4'>
				<h2 className='font-medium'>{funnel.name}</h2>
				<Confirm title={`Delete the ${funnel.name} funnel?`} onConfirm={onDelete}>
					<IconButton label='Delete' icon={IconTrash} />
				</Confirm>
			</header>
			<ol className='flex flex-col gap-1'>
				{funnel.steps.map((step, index) => {
					const reached = funnel.reached[index] ?? 0
					const before = index === 0 ? reached : (funnel.reached[index - 1] ?? 0)
					return (
						<li
							key={`${step.kind}:${step.value}`}
							className='relative flex items-center justify-between gap-4 px-2 py-1.5 text-sm'
						>
							<span
								aria-hidden
								className='absolute inset-y-0 left-0 rounded-[calc(var(--radius-control)-4px)] bg-accent/12'
								style={{ width: `${(reached / first) * 100}%` }}
							/>
							<span className='relative min-w-0 truncate'>
								{index + 1}. {stepName(step)}
							</span>
							<span className='relative flex shrink-0 gap-6 tabular-nums'>
								<span className='w-16 text-right'>{reached.toLocaleString()}</span>
								<span className='w-16 text-right text-muted'>{percent((reached / first) * 100)}</span>
								<span className='w-20 text-right text-muted'>
									{index === 0 || before === 0
										? ''
										: `-${percent(((before - reached) / before) * 100)}`}
								</span>
							</span>
						</li>
					)
				})}
			</ol>
		</section>
	)
}

const stepPlaceholder = { page: '/pricing', goal: 'signup', payment: 'any payment' } as const

const blankSteps = (): FunnelStep[] => [
	{ kind: 'page', value: '/' },
	{ kind: 'goal', value: '' },
]

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
		mutationFn: () => api.createFunnel(domainId, { name, steps }),
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
			onOpenChange={onOpenChange}
			title='Add a funnel'
			description='Two to eight steps. A page ending in * matches every path under it.'
			action='Add'
			icon={IconPlus}
			mutation={create}
			onSubmit={() => create.mutate()}
			wide
		>
			<div className='flex flex-col gap-3'>
				<Field label='Name'>
					<Input value={name} maxLength={64} required onChange={event => setName(event.target.value)} />
				</Field>
				{steps.map((step, index) => (
					// Steps have no id of their own; the list only grows and shrinks at the end.
					// oxlint-disable-next-line react/no-array-index-key
					<div key={index} className='flex items-center gap-2'>
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
							label='Remove step'
							icon={IconTrash}
							disabled={steps.length <= 2}
							onClick={() => setSteps(steps.filter((_, i) => i !== index))}
						/>
					</div>
				))}
				<div>
					<Button
						disabled={steps.length >= 8}
						onClick={() => setSteps([...steps, { kind: 'goal', value: '' }])}
					>
						<IconPlus size={16} stroke={1.75} />
						Add step
					</Button>
				</div>
			</div>
		</FormDialog>
	)
}
