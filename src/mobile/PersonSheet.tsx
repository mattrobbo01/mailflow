import Sheet from './Sheet'
import PeopleSidebar from '../components/PeopleSidebar'

/**
 * The desktop people sidebar (HubSpot card, deals, notes, meetings, recent
 * threads) served as a bottom sheet — opened from the profile icon in the
 * thread header.
 */
export default function PersonSheet({
  email, name, onClose, onOpenThread
}: {
  email: string | null
  name?: string
  onClose: () => void
  onOpenThread: (accountId: string, threadId: string) => void
}) {
  return (
    <Sheet onClose={onClose} tall>
      <PeopleSidebar email={email} name={name} onOpenThread={onOpenThread} />
    </Sheet>
  )
}
