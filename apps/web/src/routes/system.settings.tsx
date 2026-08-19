import { createFileRoute, Outlet } from '@tanstack/react-router'
import { Page, Tabs } from '../components/primitives'

export const Route = createFileRoute('/system/settings')({ component: SettingsLayout })

const tabs = [
	{ suffix: '', label: 'General' },
	{ suffix: '/registries', label: 'Registries' },
	{ suffix: '/tokens', label: 'API tokens' },
	{ suffix: '/about', label: 'About' },
]

function SettingsLayout() {
	return (
		<Page toolbar={<Tabs base='/system/settings' tabs={tabs} />}>
			<Outlet />
		</Page>
	)
}
