(function (global) {
    function attach(ctx, hubGames) {
        let currentInvite = null;

        function hideInviteToast(declinePending = true) {
            if (declinePending && currentInvite) {
                global.NetworkEngine.declineInvite(currentInvite.fromUid);
            }
            document.getElementById('invite-toast')?.classList.remove('show');
            currentInvite = null;
        }

        global.NetworkEngine.listenForInvites((invite) => {
            currentInvite = invite;
            const senderEl = document.getElementById('toast-sender');
            const gameEl = document.getElementById('toast-game-name');
            if (senderEl) senderEl.innerText = invite.fromName;
            if (gameEl) gameEl.innerText = invite.game.toUpperCase();
            document.getElementById('invite-toast')?.classList.add('show');

            const acceptBtn = document.getElementById('btn-accept-invite');
            if (!acceptBtn) return;
            acceptBtn.onclick = async () => {
                const inv = currentInvite;
                const newRoomId = inv?.roomId;
                if (!newRoomId || !inv) {
                    hideInviteToast();
                    return;
                }

                const result = await global.NetworkEngine.acceptInvite(inv.fromUid, newRoomId);
                if (!result?.ok) {
                    hideInviteToast();
                    return;
                }

                await ctx.enterPartyRoom(newRoomId, {
                    role: 'P2',
                    game: inv.game,
                    mode: inv.mode,
                    skipJoin: true
                });
                hideInviteToast(false);
            };
        });

        ctx.hideInviteToast = hideInviteToast;
        global.hideInviteToast = hideInviteToast;
    }

    global.HubInvites = { attach };
})(typeof window !== 'undefined' ? window : global);
