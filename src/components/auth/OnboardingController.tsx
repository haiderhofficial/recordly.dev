import { useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { RecordlySignInDialog } from "./RecordlySignInDialog";

// Opens only on request (Settings → Show onboarding); no first-run popup.
export function OnboardingController({
	requestNonce,
	user,
	configured,
	callbackError,
}: {
	requestNonce: number;
	user: User | null;
	configured: boolean;
	callbackError?: string;
}) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (requestNonce > 0) setOpen(true);
	}, [requestNonce]);
	const close = useCallback(() => setOpen(false), []);

	return (
		<RecordlySignInDialog
			onboarding
			variant="wide"
			open={open}
			onOpenChange={(value) => {
				if (!value) close();
			}}
			user={user}
			configured={configured}
			callbackError={callbackError}
			onAuthenticated={close}
		/>
	);
}
