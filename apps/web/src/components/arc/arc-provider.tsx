'use client'

/** Lets the app swap the link element Arc components render (kuratlielia/arc-library#13); a plain `<a>` without one. */
import {
	createContext,
	createElement,
	useContext,
	type AnchorHTMLAttributes,
	type ComponentType,
	type ReactNode,
	type Ref,
} from 'react'

export interface ArcLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
	href: string
	ref?: Ref<HTMLAnchorElement>
}

type ArcLinkComponent = ComponentType<ArcLinkProps>

function ArcAnchor(props: ArcLinkProps) {
	return <a {...props} />
}

const ArcLinkContext = createContext<ArcLinkComponent>(ArcAnchor)

export function ArcProvider({ link, children }: { link: ArcLinkComponent; children: ReactNode }) {
	return <ArcLinkContext.Provider value={link}>{children}</ArcLinkContext.Provider>
}

/** What Arc components render for a link: the provider's link component, or a plain anchor. */
export function ArcLink(props: ArcLinkProps) {
	return createElement(useContext(ArcLinkContext), props)
}
