import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

// Arrow icons
export function ArrowLeftIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(12 12) rotate(-270) translate(-12 -12) translate(5.5 4)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<line x1='6.7743' y1='15.75' x2='6.7743' y2='0.75' />
				<polyline points='12.7987 9.7002 6.7747 15.7502 0.7497 9.7002' />
			</g>
		</svg>
	)
}

export function ArrowRightIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(12 12) rotate(-90) translate(-12 -12) translate(5.5 4)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<line x1='6.7743' y1='15.75' x2='6.7743' y2='0.75' />
				<polyline points='12.7987 9.7002 6.7747 15.7502 0.7497 9.7002' />
			</g>
		</svg>
	)
}

export function ArrowUpIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(12 12) rotate(-180) translate(-12 -12) translate(5.5 4)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<line x1='6.7743' y1='15.75' x2='6.7743' y2='0.75' />
				<polyline points='12.7987 9.7002 6.7747 15.7502 0.7497 9.7002' />
			</g>
		</svg>
	)
}

export function ArrowDownIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(5.5 4)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<line x1='6.7743' y1='15.75' x2='6.7743' y2='0.75' />
				<polyline points='12.7987 9.7002 6.7747 15.7502 0.7497 9.7002' />
			</g>
		</svg>
	)
}

export function ChevronLeftIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M15 19L8 12L15 5'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function ChevronRightIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M9 5L16 12L9 19'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function ChevronUpIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M5 16L12 9L19 16'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function ChevronDownIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M19 9L12 16L5 9'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function ChevronUpDownIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M17 14L12 19L7 14'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M7 10L12 5L17 10'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

// UI icons
export function CheckIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M19 6.85547C13.5636 9.48764 10.2433 14.2837 8.72078 17.1442C7.74399 15.5051 6.50533 14.0476 5 12.7764'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function CloseIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path d='M6 6L18 18' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
			<path d='M18 6L6 18' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
		</svg>
	)
}

export function SearchIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(2 2)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<circle cx='9.76659044' cy='9.76659044' r='8.9885584' />
				<line x1='16.0183067' y1='16.4851259' x2='19.5423342' y2='20.0000001' />
			</g>
		</svg>
	)
}

export function MoreHorizontalIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g transform='translate(2 2)' stroke='currentColor' strokeLinecap='round' strokeLinejoin='round'>
				<path
					d='M10.0002,0.7501 C15.1082,0.7501 19.2502,4.8911 19.2502,10.0001 C19.2502,15.1081 15.1082,19.2501 10.0002,19.2501 C4.8912,19.2501 0.7502,15.1081 0.7502,10.0001 C0.7502,4.8921 4.8922,0.7501 10.0002,0.7501 Z'
					strokeWidth='2'
				/>
				<line x1='13.9394' y1='10.013' x2='13.9484' y2='10.013' strokeWidth='2' />
				<line x1='9.9304' y1='10.013' x2='9.9394' y2='10.013' strokeWidth='2' />
				<line x1='5.9214' y1='10.013' x2='5.9304' y2='10.013' strokeWidth='2' />
			</g>
		</svg>
	)
}

export function SettingsIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(2.5 1.5)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<path d='M18.3066362,6.12356982 L17.6842106,5.04347829 C17.1576365,4.12955711 15.9906873,3.8142761 15.0755149,4.33867279 C14.6398815,4.59529992 14.1200613,4.66810845 13.6306859,4.54104256 C13.1413105,4.41397667 12.7225749,4.09747295 12.4668193,3.66132725 C12.3022855,3.38410472 12.2138742,3.06835005 12.2105264,2.74599544 C12.2253694,2.22917739 12.030389,1.72835784 11.6700024,1.3576252 C11.3096158,0.986892553 10.814514,0.777818938 10.2974829,0.778031878 L9.04347831,0.778031878 C8.53694532,0.778031878 8.05129106,0.97987004 7.69397811,1.33890085 C7.33666515,1.69793166 7.13715288,2.18454839 7.13958814,2.69107553 C7.12457503,3.73688099 6.27245786,4.57676682 5.22654465,4.57665906 C4.90419003,4.57331126 4.58843537,4.48489995 4.31121284,4.32036615 C3.39604054,3.79596946 2.22909131,4.11125048 1.70251717,5.02517165 L1.03432495,6.12356982 C0.508388616,7.03634945 0.819378585,8.20256183 1.72997713,8.73226549 C2.32188101,9.07399614 2.68650982,9.70554694 2.68650982,10.3890161 C2.68650982,11.0724852 2.32188101,11.704036 1.72997713,12.0457667 C0.820534984,12.5718952 0.509205679,13.7352837 1.03432495,14.645309 L1.6659039,15.7345539 C1.9126252,16.1797378 2.3265816,16.5082503 2.81617164,16.6473969 C3.30576167,16.7865435 3.83061824,16.7248517 4.27459956,16.4759726 C4.71105863,16.2212969 5.23116727,16.1515203 5.71931837,16.2821523 C6.20746948,16.4127843 6.62321383,16.7330005 6.87414191,17.1716248 C7.03867571,17.4488473 7.12708702,17.764602 7.13043482,18.0869566 C7.13043482,19.1435014 7.98693356,20.0000001 9.04347831,20.0000001 L10.2974829,20.0000001 C11.3504633,20.0000001 12.2054882,19.1490783 12.2105264,18.0961099 C12.2080776,17.5879925 12.4088433,17.0999783 12.7681408,16.7406809 C13.1274382,16.3813834 13.6154524,16.1806176 14.1235699,16.1830664 C14.4451523,16.1916732 14.7596081,16.2797208 15.0389017,16.4393593 C15.9516813,16.9652957 17.1178937,16.6543057 17.6475973,15.7437072 L18.3066362,14.645309 C18.5617324,14.2074528 18.6317479,13.6859659 18.5011783,13.1963297 C18.3706086,12.7066935 18.0502282,12.2893121 17.6109841,12.0366133 C17.17174,11.7839145 16.8513595,11.3665332 16.7207899,10.876897 C16.5902202,10.3872608 16.6602358,9.86577384 16.9153319,9.42791767 C17.0812195,9.13829096 17.3213574,8.89815312 17.6109841,8.73226549 C18.5161253,8.20284891 18.8263873,7.04344892 18.3066362,6.13272314 Z' />
				<circle cx='9.67505726' cy='10.3890161' r='2.63615562' />
			</g>
		</svg>
	)
}

export function SidebarIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path d='M4 19H20' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
			<path d='M4 5H20' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
			<path d='M4 12H20' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
		</svg>
	)
}

export function PlusIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path d='M6 12H18' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
			<path d='M12 6V18' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
		</svg>
	)
}

export function FilterIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(4 4.5)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<line x1='6.33015655' y1='12.0929063' x2='0.0294393477' y2='12.0929063' />
				<line x1='9.14048198' y1='2.40037662' x2='15.4411992' y2='2.40037662' />
				<path d='M4.72628792,2.34625359 C4.72628792,1.05059752 3.66812728,0 2.36314396,0 C1.05816064,0 0,1.05059752 0,2.34625359 C0,3.64190965 1.05816064,4.69250717 2.36314396,4.69250717 C3.66812728,4.69250717 4.72628792,3.64190965 4.72628792,2.34625359 Z' />
				<path d='M16,12.0537464 C16,10.7580903 14.942654,9.70749283 13.6376706,9.70749283 C12.3318727,9.70749283 11.2737121,10.7580903 11.2737121,12.0537464 C11.2737121,13.3494025 12.3318727,14.4 13.6376706,14.4 C14.942654,14.4 16,13.3494025 16,12.0537464 Z' />
			</g>
		</svg>
	)
}

export function CircleIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<circle cx='12' cy='12' r='5' fill='currentColor' />
		</svg>
	)
}

export function SlidersIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(2 3)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<line x1='14.8395556' y1='17.1642222' x2='14.8395556' y2='3.54644444' />
				<polyline points='18.9172222 13.0681111 14.8394444 17.1647778 10.7616667 13.0681111' />
				<line x1='4.91111111' y1='0.832888889' x2='4.91111111' y2='14.4506667' />
				<polyline points='0.833444444 4.929 4.91122222 0.832333333 8.989 4.929' />
			</g>
		</svg>
	)
}

export function GripVerticalIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<circle cx='9' cy='5' r='1.5' fill='currentColor' />
			<circle cx='15' cy='5' r='1.5' fill='currentColor' />
			<circle cx='9' cy='12' r='1.5' fill='currentColor' />
			<circle cx='15' cy='12' r='1.5' fill='currentColor' />
			<circle cx='9' cy='19' r='1.5' fill='currentColor' />
			<circle cx='15' cy='19' r='1.5' fill='currentColor' />
		</svg>
	)
}

// Team and user icons
export function TeamIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				fillRule='evenodd'
				clipRule='evenodd'
				d='M9.93058 14.875C6.55437 14.875 3.67578 15.3852 3.67578 17.4278C3.67578 19.4714 6.53908 19.9987 9.93058 19.9987C13.305 19.9987 16.1854 19.4876 16.1854 17.4458C16.1854 15.4032 13.323 14.875 9.93058 14.875Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M17.9102 14.4727C19.331 14.6841 20.3235 15.1826 20.3235 16.2094C20.3235 16.9148 19.8556 17.3737 19.1015 17.6599'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				fillRule='evenodd'
				clipRule='evenodd'
				d='M13.9261 7.9953C13.9261 10.2017 12.1373 11.9906 9.93084 11.9906C7.72353 11.9906 5.93555 10.2017 5.93555 7.9953C5.93555 5.78798 7.72353 4 9.93084 4C12.1373 4 13.9261 5.78798 13.9261 7.9953Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M15.9746 10.9479C17.4638 10.7364 18.5716 9.46317 18.5734 7.95954C18.5734 6.4802 17.5034 5.21772 16.043 4.97656'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function UserIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(4.814286 2.814476)'
				stroke='currentColor'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<path
					d='M7.17047619,12.531714 C3.30285714,12.531714 0,13.1164759 0,15.4583807 C0,17.8002854 3.28190476,18.4059997 7.17047619,18.4059997 C11.0380952,18.4059997 14.34,17.8202854 14.34,15.479333 C14.34,13.1383807 11.0590476,12.531714 7.17047619,12.531714 Z'
					strokeWidth='2'
				/>
				<path
					d='M7.17047634,9.19142857 C9.70857158,9.19142857 11.7657144,7.13333333 11.7657144,4.5952381 C11.7657144,2.05714286 9.70857158,0 7.17047634,0 C4.6323811,0 2.574259,2.05714286 2.574259,4.5952381 C2.56571443,7.1247619 4.60952396,9.18285714 7.13809539,9.19142857 L7.17047634,9.19142857 Z'
					strokeWidth='1.42857143'
				/>
			</g>
		</svg>
	)
}

export function TicketIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(2 4)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<g transform='translate(11.349700 0.250300)'>
					<line x1='0.5' y1='0' x2='0.5' y2='2.42' />
					<line x1='0.5' y1='13.5098' x2='0.5' y2='15.5338' />
					<line x1='0.5' y1='10.0743' x2='0.5' y2='5.2533' />
				</g>
				<path d='M16.7021277,16 C18.5241969,16 20,14.5425518 20,12.7431441 L20,10.1506373 C18.7943262,10.1506373 17.8233208,9.19170851 17.8233208,8.00103 C17.8233208,6.81035149 18.7943262,5.85039269 20,5.85039269 L19.998957,3.25685593 C19.998957,1.45744818 18.522111,0 16.7010847,0 L3.29891531,0 C1.47788903,0 0.00104297038,1.45744818 0.00104297038,3.25685593 L0,5.93485258 C1.20567376,5.93485258 2.17667918,6.81035149 2.17667918,8.00103 C2.17667918,9.19170851 1.20567376,10.1506373 0,10.1506373 L0,12.7431441 C0,14.5425518 1.47580309,16 3.29787234,16 L16.7021277,16 Z' />
			</g>
		</svg>
	)
}

export function ProjectIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(3 3)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<path d='M0,3.5 C0,0.874787053 0.0281092,0 3.5,0 C6.97189053,0 7,0.874787053 7,3.5 C7,6.12521295 7.01107281,7 3.5,7 C-0.0110730841,7 0,6.12521295 0,3.5 Z' />
				<path d='M11,3.5 C11,0.874787053 11.0281092,0 14.5,0 C17.9718905,0 18,0.874787053 18,3.5 C18,6.12521295 18.0110728,7 14.5,7 C10.9889269,7 11,6.12521295 11,3.5 Z' />
				<path d='M0,14.5 C0,11.8747871 0.0281092,11 3.5,11 C6.97189053,11 7,11.8747871 7,14.5 C7,17.1252129 7.01107281,18 3.5,18 C-0.0110730841,18 0,17.1252129 0,14.5 Z' />
				<path d='M11,14.5 C11,11.8747871 11.0281092,11 14.5,11 C17.9718905,11 18,11.8747871 18,14.5 C18,17.1252129 18.0110728,18 14.5,18 C10.9889269,18 11,17.1252129 11,14.5 Z' />
			</g>
		</svg>
	)
}

export function IssueIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g transform='translate(2 2)' stroke='currentColor' strokeLinecap='round' strokeLinejoin='round'>
				<path
					d='M14.3341,0.7501 L5.6651,0.7501 C2.6441,0.7501 0.7501,2.8891 0.7501,5.9161 L0.7501,14.0841 C0.7501,17.1111 2.6351,19.2501 5.6651,19.2501 L14.3331,19.2501 C17.3641,19.2501 19.2501,17.1111 19.2501,14.0841 L19.2501,5.9161 C19.2501,2.8891 17.3641,0.7501 14.3341,0.7501 Z'
					strokeWidth='2'
				/>
				<line x1='9.9947' y1='14.0001' x2='9.9947' y2='10.0001' strokeWidth='2' />
				<line x1='9.9899' y1='6.2043' x2='9.9999' y2='6.2043' strokeWidth='2' />
			</g>
		</svg>
	)
}

export function MailIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M21 15.0944C21 17.8596 19.1552 20.1072 16.4183 20.1004H7.58173C4.84476 20.1072 3 17.8596 3 15.0944V8.91315C3 6.15088 4.84476 3.90039 7.58173 3.90039H16.4183C19.1552 3.90039 21 6.15088 21 8.91315V15.0944Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M20.6269 6.97363L14.1225 12.2626C12.8976 13.2358 11.1616 13.2358 9.93667 12.2626L3.37695 6.97363'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function CalendarIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(3 2)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<line x1='0.0926400664' y1='7.40425532' x2='17.9165888' y2='7.40425532' />
				<line x1='13.4420736' y1='11.3096927' x2='13.4513376' y2='11.3096927' />
				<line x1='9.00461445' y1='11.3096927' x2='9.01387846' y2='11.3096927' />
				<line x1='4.55789127' y1='11.3096927' x2='4.56715527' y2='11.3096927' />
				<line x1='13.4420736' y1='15.1962175' x2='13.4513376' y2='15.1962175' />
				<line x1='9.00461445' y1='15.1962175' x2='9.01387846' y2='15.1962175' />
				<line x1='4.55789127' y1='15.1962175' x2='4.56715527' y2='15.1962175' />
				<line x1='13.0437213' y1='0' x2='13.0437213' y2='3.29078014' />
				<line x1='4.96550756' y1='0' x2='4.96550756' y2='3.29078014' />
				<path d='M13.2382655,1.57919622 L4.77096342,1.57919622 C1.83427331,1.57919622 0,3.21513002 0,6.22222222 L0,15.2718676 C0,18.3262411 1.83427331,20 4.77096342,20 L13.2290015,20 C16.1749556,20 18,18.3546099 18,15.3475177 L18,6.22222222 C18.0092289,3.21513002 16.1842196,1.57919622 13.2382655,1.57919622 Z' />
			</g>
		</svg>
	)
}

export function DiscordIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M7.78216 3H16.2169C19.165 3 21 5.08119 21 8.02638V15.9736C21 18.9188 19.165 21 16.2159 21H7.78216C4.83405 21 3 18.9188 3 15.9736V8.02638C3 5.08119 4.84281 3 7.78216 3Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M10.3784 11.9937V12.0305M10.5276 12.0016C10.5276 12.0844 10.4603 12.1516 10.3775 12.1516C10.2947 12.1516 10.2275 12.0844 10.2275 12.0016C10.2275 11.9187 10.2947 11.8516 10.3775 11.8516C10.4603 11.8516 10.5276 11.9187 10.5276 12.0016Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M13.6235 11.9937V12.0305M13.7727 12.0016C13.7727 12.0844 13.7055 12.1516 13.6226 12.1516C13.5398 12.1516 13.4727 12.0844 13.4727 12.0016C13.4727 11.9187 13.5398 11.8516 13.6226 11.8516C13.7055 11.8516 13.7727 11.9187 13.7727 12.0016Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M10.3486 7.8125C9.67068 7.92924 9.00213 8.1184 8.3547 8.37999C8.14651 8.46481 7.9717 8.61526 7.85682 8.80848C6.80139 10.597 6.34241 12.6749 6.54631 14.7416C6.61672 15.4414 7.42321 15.7686 8.02845 16.0141C8.09367 16.0406 8.15655 16.0661 8.21592 16.091C9.16565 16.4949 9.62005 15.4856 9.92411 14.7928C11.2916 15.0944 12.7084 15.0944 14.0758 14.7928C14.3791 15.4859 14.8348 16.4947 15.784 16.091C15.8434 16.0661 15.9063 16.0406 15.9715 16.0141C16.5767 15.7686 17.3832 15.4414 17.4536 14.7416C17.6575 12.6749 17.1986 10.597 16.1431 8.80848C16.0282 8.61525 15.8534 8.46481 15.6452 8.37999C14.9978 8.1184 14.3293 7.92924 13.6513 7.8125L13.1427 8.39502H10.8572L10.3486 7.8125Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function SlackIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
				<path d='M13.6299 18.2344H15.0125C15.7762 18.2344 16.3941 18.8532 16.3941 19.617C16.3941 20.3798 15.7743 20.9986 15.0115 20.9986C14.2477 20.9986 13.6289 20.3798 13.6299 19.616V18.2344Z' />
				<path d='M5.76419 15.0134V13.6328H4.38064C3.61783 13.6328 2.99903 14.2526 3 15.0164C3 15.7792 3.61978 16.397 4.38258 16.397C5.14636 16.396 5.76419 15.7772 5.76419 15.0134Z' />
				<path d='M18.2363 10.3736H19.6189C20.3827 10.3736 21.0015 9.75476 21.0005 8.99098C21.0005 8.22818 20.3817 7.60938 19.6189 7.60938C18.8551 7.60938 18.2363 8.22818 18.2363 8.99196V10.3736Z' />
				<path d='M10.3697 4.38258V5.76419H8.98708C8.2233 5.76419 7.60547 5.14538 7.60547 4.38161C7.60547 3.6188 8.22427 3 8.98708 3C9.75085 3 10.3697 3.6188 10.3697 4.38258Z' />
				<path d='M8.99151 8.52734C9.75334 8.52734 10.3702 9.14615 10.3692 9.90798C10.3683 10.6747 9.74945 11.2915 8.98762 11.2906H4.38161C3.6188 11.2906 3 10.6718 3 9.90798C3 9.14518 3.6188 8.52734 4.38161 8.52734H8.99151Z' />
				<path d='M15.0066 12.7109C14.2448 12.7109 13.6279 13.3297 13.6289 14.0916C13.6299 14.8583 14.2487 15.4742 15.0105 15.4732H19.6165C20.3793 15.4732 20.9981 14.8544 20.9981 14.0916C20.9981 13.3288 20.3793 12.7109 19.6165 12.7109H15.0066Z' />
				<path d='M11.2906 15.0096C11.2896 14.2477 10.6708 13.6318 9.90895 13.6328C9.1442 13.6338 8.52637 14.2526 8.52734 15.0134V19.6204C8.54583 20.357 9.13837 20.9495 9.87587 20.968C10.6387 20.9865 11.2721 20.3832 11.2906 19.6204V15.0096Z' />
				<path d='M12.709 8.99307C12.71 9.7549 13.3288 10.3718 14.0906 10.3708C14.8563 10.3698 15.4732 9.75101 15.4732 8.99015V4.38317C15.4547 3.64566 14.8612 3.05313 14.1246 3.03561C13.3618 3.01615 12.7284 3.61939 12.709 4.38317V8.99307Z' />
			</g>
		</svg>
	)
}

// Workspace settings icons
export function TagIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				fillRule='evenodd'
				clipRule='evenodd'
				d='M3.01582 5.96647C3.01874 4.5547 4.08608 3.28888 5.47158 3.0505C5.75568 3.00088 9.08808 3.00769 10.4668 3.00866C11.8309 3.00964 12.9936 3.50001 13.9568 4.4613C16.002 6.50257 18.0452 8.5458 20.0855 10.591C21.2929 11.8004 21.3095 13.6568 20.1069 14.8701C18.3721 16.6214 16.6285 18.364 14.8782 20.0988C13.6659 21.3004 11.8095 21.2848 10.5991 20.0774C8.53544 18.0195 6.47178 15.9617 4.41688 13.8951C3.62197 13.0954 3.15301 12.1292 3.0489 10.9996C2.96522 10.0967 3.01387 6.73998 3.01582 5.96647Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M8.72189 11.8725V11.821M8.71522 11.668C8.59122 11.668 8.49022 11.769 8.49122 11.893C8.49122 12.017 8.59222 12.118 8.71622 12.118C8.84022 12.118 8.94122 12.017 8.94122 11.893C8.94122 11.768 8.84022 11.668 8.71522 11.668Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function ListIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M8 17.9961H20.0006'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M8 11.9961H20.0006'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M8 5.99609H20.0006'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M4.01132 5.98139V6.04537M4.27058 5.99514C4.27058 6.13916 4.15374 6.2559 4.00972 6.2559C3.86571 6.2559 3.74902 6.13916 3.74902 5.99514C3.74902 5.85112 3.86571 5.73438 4.00972 5.73438C4.15374 5.73438 4.27058 5.85112 4.27058 5.99514Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M4.01132 12.1103V12.1743M4.27058 12.124C4.27058 12.2681 4.15374 12.3848 4.00972 12.3848C3.86571 12.3848 3.74902 12.2681 3.74902 12.124C3.74902 11.98 3.86571 11.8633 4.00972 11.8633C4.15374 11.8633 4.27058 11.98 4.27058 12.124Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M4.01132 17.9811V18.0451M4.27058 17.9949C4.27058 18.1389 4.15374 18.2557 4.00972 18.2557C3.86571 18.2557 3.74902 18.1389 3.74902 17.9949C3.74902 17.8509 3.86571 17.7341 4.00972 17.7341C4.15374 17.7341 4.27058 17.8509 4.27058 17.9949Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function TrashIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(3 2)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<path d='M16.3249,7.4682 C16.3249,7.4682 15.7819,14.2032 15.4669,17.0402 C15.3169,18.3952 14.4799,19.1892 13.1089,19.2142 C10.4999,19.2612 7.8879,19.2642 5.2799,19.2092 C3.9609,19.1822 3.1379,18.3782 2.9909,17.0472 C2.6739,14.1852 2.1339,7.4682 2.1339,7.4682' />
				<line x1='17.7082' y1='4.2397' x2='0.7502' y2='4.2397' />
				<path d='M14.4406,4.2397 C13.6556,4.2397 12.9796,3.6847 12.8256,2.9157 L12.5826,1.6997 C12.4326,1.1387 11.9246,0.7507 11.3456,0.7507 L7.1126,0.7507 C6.5336,0.7507 6.0256,1.1387 5.8756,1.6997 L5.6326,2.9157 C5.4786,3.6847 4.8026,4.2397 4.0176,4.2397' />
			</g>
		</svg>
	)
}

export function LayoutGridIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M7.78301 3H16.2175C19.1655 3 20.9995 5.08113 20.9995 8.02625V15.9733C20.9995 18.9184 19.1655 20.9995 16.2165 20.9995H7.78301C4.83498 20.9995 3 18.9184 3 15.9733V8.02625C3 5.08113 4.84374 3 7.78301 3Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M12 3V20.9995'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M11.9998 14.9177H3M20.9995 10.1309H11.9998'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function ZapIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				fillRule='evenodd'
				clipRule='evenodd'
				d='M19.77 9.18607L14.8117 4.22776C13.0837 2.49975 10.7767 2.63986 9.04483 4.37079L4.37355 9.04304C2.64165 10.7749 2.49667 13.076 4.22955 14.8089L9.18786 19.7672C10.9217 21.5011 13.2238 21.3561 14.9547 19.6252L19.627 14.9529C21.3589 13.221 21.5029 10.9189 19.77 9.18607Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M11.9512 15.5L14.2148 12.001H9.71484L11.9761 8.5'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function MessageSquareIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(2 3)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<path d='M15.9026143,5.8511436 L11.4593272,9.46418164 C10.6198313,10.1301843 9.4387043,10.1301843 8.59920842,9.46418164 L4.11842516,5.8511436' />
				<path d='M14.9088637,17.9999789 C17.9502135,18.0083748 20,15.5095497 20,12.4383622 L20,5.57001263 C20,2.49882508 17.9502135,0 14.9088637,0 L5.09113634,0 C2.04978648,0 0,2.49882508 0,5.57001263 L0,12.4383622 C0,15.5095497 2.04978648,18.0083748 5.09113634,17.9999789 L14.9088637,17.9999789 Z' />
			</g>
		</svg>
	)
}

export function PlugIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M7.78216 3H16.2169C19.165 3 21 5.08119 21 8.02638V15.9736C21 18.9188 19.165 21 16.2159 21H7.78216C4.83405 21 3 18.9188 3 15.9736V8.02638C3 5.08119 4.84281 3 7.78216 3Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M10.5039 12.0019H10.5769M13.3497 12.0019H13.4227M17.1699 12.0024C17.1699 9.14673 14.8552 6.83203 11.9995 6.83203C9.1438 6.83203 6.82812 9.14673 6.82812 12.0024C6.82812 14.8581 9.1438 17.1728 11.9995 17.1728C14.8552 17.1728 17.1699 14.8581 17.1699 12.0024Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function ClockIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(2 2)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<path d='M19.2498,10.0005 C19.2498,15.1095 15.1088,19.2505 9.9998,19.2505 C4.8908,19.2505 0.7498,15.1095 0.7498,10.0005 C0.7498,4.8915 4.8908,0.7505 9.9998,0.7505 C15.1088,0.7505 19.2498,4.8915 19.2498,10.0005 Z' />
				<polyline points='13.4314 12.9429 9.6614 10.6939 9.6614 5.8469' />
			</g>
		</svg>
	)
}

export function FileTextIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M9.05859 12.5771V11.596C9.05859 11.3254 9.27856 11.1055 9.54913 11.1055H14.4525C14.7231 11.1055 14.9431 11.3254 14.9431 11.596V12.5771'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M13.4715 16.9899H10.5293M11.9992 11.1055V16.99'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M13.7857 3.00004C14.3434 3.00004 14.8777 3.22681 15.2641 3.62975L19.055 7.57935C19.422 7.96088 19.6264 8.46991 19.6264 8.99937V17.1633C19.641 19.2199 18.0234 20.9163 15.9697 21L8.04424 20.999C5.97114 20.9533 4.32823 19.2364 4.37398 17.1633V6.65667C4.42264 4.61764 6.09378 2.99128 8.13379 3.00004H13.7857Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M14.2695 3.0625V5.95511C14.2686 7.36637 15.4112 8.51291 16.8234 8.51583H19.5623'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function StarIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<g
				transform='translate(3 3.5)'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			>
				<path d='M10.1042564,0.67700614 L11.9316681,4.32775597 C12.1107648,4.68615589 12.4564632,4.93467388 12.8573484,4.99218218 L16.9453359,5.58061527 C17.9553583,5.72643988 18.3572847,6.95054503 17.6263201,7.65194084 L14.6701824,10.4924399 C14.3796708,10.7717659 14.2474307,11.173297 14.3161539,11.5676396 L15.0137982,15.5778163 C15.1856062,16.5698344 14.1297683,17.3266846 13.2269958,16.8573759 L9.57321374,14.9626829 C9.21502023,14.7768079 8.78602103,14.7768079 8.42678626,14.9626829 L4.77300425,16.8573759 C3.87023166,17.3266846 2.81439382,16.5698344 2.98724301,15.5778163 L3.68384608,11.5676396 C3.75256926,11.173297 3.62032921,10.7717659 3.32981762,10.4924399 L0.373679928,7.65194084 C-0.357284727,6.95054503 0.0446417073,5.72643988 1.05466409,5.58061527 L5.14265161,4.99218218 C5.54353679,4.93467388 5.89027643,4.68615589 6.06937319,4.32775597 L7.89574356,0.67700614 C8.34765049,-0.225668713 9.65234951,-0.225668713 10.1042564,0.67700614 Z' />
			</g>
		</svg>
	)
}

export function ExternalLinkIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path d='M11 19H5V13' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
			<path d='M13 5H19V11' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
			<path d='M19 5L13 11' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
			<path d='M5 19L11 13' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
		</svg>
	)
}

export function ExpandIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M10.7657 6.90889C10.7657 7.903 11.5716 8.70889 12.5657 8.70889L12.7458 8.70889L8.70889 12.7458L8.70889 12.5657C8.70889 11.5716 7.903 10.7657 6.90889 10.7657C5.91477 10.7657 5.10889 11.5716 5.10889 12.5657L5.10889 17.0912C5.10889 18.0853 5.91477 18.8912 6.90889 18.8912H11.4344C12.4285 18.8912 13.2344 18.0853 13.2344 17.0912C13.2344 16.0971 12.4285 15.2912 11.4344 15.2912H11.2546L15.2912 11.2546V11.4344C15.2912 12.4285 16.0971 13.2344 17.0912 13.2344C18.0853 13.2344 18.8912 12.4285 18.8912 11.4344L18.8912 6.90889C18.8912 6.63177 18.8286 6.36928 18.7167 6.13479C18.6596 6.01493 18.5885 5.90007 18.5034 5.79268C18.4068 5.67063 18.2948 5.5614 18.1702 5.46795C18.1028 5.41743 18.0328 5.37223 17.9606 5.33237C17.7029 5.18995 17.4065 5.10889 17.0912 5.10889L12.5657 5.10889C11.5716 5.10889 10.7657 5.91477 10.7657 6.90889Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function PaperclipIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M21 12.3955L14.6912 18.7043C12.0164 21.3781 7.67982 21.3781 5.00605 18.7043C2.33132 16.0296 2.33132 11.693 5.00605 9.01826L9.39909 4.6262C11.1758 2.84856 14.0558 2.84856 15.8325 4.6262C17.6091 6.4019 17.6091 9.28292 15.8325 11.0596L11.5474 15.3446C10.6503 16.2417 9.19671 16.2417 8.29961 15.3446C7.40252 14.4475 7.40252 12.9939 8.29961 12.0968L12.3433 8.05306'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function AlertTriangleIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M19.004 20.1007H4.99575C3.46195 20.1007 2.50321 18.4407 3.26962 17.1118L10.3179 4.89678C11.0872 3.56308 13.0135 3.56794 13.776 4.90552L20.7359 17.1206C21.4926 18.4494 20.5329 20.1007 19.004 20.1007Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M12.0117 13.2827V10.2715M12.0098 16.328V16.2794'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function QuestionCircleIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M21 12C21 7.02908 16.9709 3 12 3C7.02908 3 3 7.02908 3 12C3 16.9699 7.02908 21 12 21C16.9709 21 21 16.9699 21 12Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M11.9473 16.2245V16.1963'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M11.9462 13.7496C11.9345 12.8583 12.745 12.4808 13.3473 12.1373C14.0819 11.7326 14.5791 11.0875 14.5791 10.1933C14.5791 8.86815 13.5078 7.80469 12.1914 7.80469C10.8662 7.80469 9.80273 8.86815 9.80273 10.1933'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function ShieldIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M12 21C12 21 19.5 17.5 19.5 11V5L12 3L4.5 5V11C4.5 17.5 12 21 12 21Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M9 11.5L11 13.5L15 9.5'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function ChartBarIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path d='M6 20V10' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
			<path d='M12 20V4' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
			<path d='M18 20V14' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
		</svg>
	)
}

export function FlagIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path d='M5 21V4' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
			<path
				d='M5 4H17L14.5 8.5L17 13H5'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function SparkIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M12 3L13.5 9L19 10.5L13.5 12L12 18L10.5 12L5 10.5L10.5 9L12 3Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function GlobeIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				fillRule='evenodd'
				clipRule='evenodd'
				d='M12 3C16.9709 3 21 7.02908 21 12C21 16.9709 16.9709 21 12 21C7.02908 21 3 16.9709 3 12C3 7.02908 7.02908 3 12 3Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				fillRule='evenodd'
				clipRule='evenodd'
				d='M12 3C13.8506 3 15.35 7.02908 15.35 12C15.35 16.9709 13.8506 21 12 21C10.1494 21 8.6499 16.9709 8.6499 12C8.6499 7.02908 10.1494 3 12 3Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M4.01465 7.84375C5.53151 8.31175 7.17974 8.62991 8.87465 8.80797C10.9344 9.02397 13.0604 9.02397 15.1299 8.80797C16.8249 8.62991 18.4731 8.31175 19.99 7.84375'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
			<path
				d='M19.99 16.1536C18.4731 15.6856 16.8249 15.3674 15.1299 15.1893C13.0604 14.9733 10.9344 14.9733 8.87465 15.1893C7.17974 15.3674 5.53151 15.6856 4.01465 16.1536'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}

export function DiamondIcon(props: IconProps) {
	return (
		<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
			<path
				d='M12 3L21 12L12 21L3 12L12 3Z'
				stroke='currentColor'
				strokeWidth='2'
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</svg>
	)
}
