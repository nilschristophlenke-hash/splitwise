// ============================================================================
// Splitwise Clone — i18n (English / German)
//
// SW.I18n is the one place that knows which language is active and what
// every user-facing string looks like in each of them. Nothing else in the
// app should hard-code English text any more - it should ask SW.I18n.t()
// for it instead, so switching languages is just a matter of re-reading
// the same page.
//
// Public API:
//   SW.I18n.t(key, params)      - look up a string, filling in {placeholders}
//   SW.I18n.getLang()           - 'en' or 'de'
//   SW.I18n.setLang(lang)       - switch language, persist it, re-render
//   SW.I18n.onChange(fn)        - fn() runs after every language switch;
//                                 returns an unsubscribe function
//   SW.I18n.applyStatic(root)   - translate every [data-i18n] / [data-i18n-attr]
//                                 element under root (defaults to the whole page)
//
// This file also wires up the EN/DE toggle buttons in the page (see
// wireLangSwitches below) - that part isn't in the public API because
// nothing outside this file needs to touch it.
// ============================================================================

var SW = SW || {};

(function () {
  'use strict';

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  // --------------------------------------------------------------------
  // The dictionary. Two flat maps (not nested objects) keyed by dotted
  // names like "common.cancel" - flat because that keeps t() a single
  // property lookup instead of walking a path.
  // --------------------------------------------------------------------
  var DICT = {
    en: {
      // ---- shared/common ----
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.closeDialog': 'Close dialog',
      'common.dismiss': 'Dismiss',
      'common.save': 'Save',
      'common.delete': 'Delete',
      'common.value': 'Value',
      'common.edit': 'Edit',
      'common.add': 'Add',
      'common.name': 'Name',
      'common.areYouSure': 'Are you sure?',

      // ---- header ----
      'header.currentUser': 'Current user',
      'header.dataMenu': 'Data ▾',
      'header.export': 'Export JSON',
      'header.import': 'Import JSON…',
      'header.importFileAria': 'Choose a JSON file to import',
      'header.loadDemo': 'Load demo data',
      'header.resetAll': 'Reset all data',
      'header.admin': 'Admin',
      'header.signOut': 'Sign out',

      // ---- sidebar ----
      'sidebar.groups': 'Groups',
      'sidebar.newGroup': '+ New group',
      'sidebar.joinWithCode': 'Join with code',
      'sidebar.noGroupsYet': 'No groups yet.',

      // ---- pluralized units ----
      'unit.expense.one': 'expense',
      'unit.expense.other': 'expenses',
      'unit.settlement.one': 'settlement',
      'unit.settlement.other': 'settlements',
      'unit.member.one': 'member',
      'unit.member.other': 'members',
      'unit.group.one': 'group',
      'unit.group.other': 'groups',

      // ---- empty states ----
      'empty.selectGroupTitle': 'Select a group',
      'empty.selectGroupBody': 'Choose a group from the sidebar to see its expenses and balances.',
      'empty.noGroupsTitle': 'No groups yet',
      'empty.noGroupsBody': 'Create a group to start splitting expenses with friends.',
      'empty.noExpensesTitle': 'No expenses yet',
      'empty.noExpensesBody': 'Add your first expense to start splitting costs.',

      // ---- group view ----
      'group.rename': 'Rename group',
      'group.renameSubmit': 'Rename',
      'group.renamed': 'Group renamed',
      'group.renameFailed': 'Could not rename group.',
      'group.delete': 'Delete group',
      'group.deleteTitle': 'Delete this group?',
      'group.deleteBody.main': '{name} and its {count} {expenseWord} will be permanently deleted.',
      'group.deleteBody.sharedSuffix': ' This removes them for all {count} {memberWord}, not just you.',
      'group.deleteBody.cannotUndo': ' This cannot be undone.',
      'group.deleted': 'Group deleted',
      'group.deleteFailed': 'Could not delete group.',
      'group.invite': 'Invite',
      'group.addMember': '+ Member',
      'group.addMemberTitle': 'Add a member',
      'group.addMemberPlaceholder': 'e.g. Mara',
      'group.addMemberHint': 'Demo mode only — with an account, people join with an invite code.',
      'group.memberAdded': 'Member added',
      'group.memberAddFailed': 'Could not add member.',
      'group.memberRemoved': 'Member removed',
      'group.memberRemoveFailed': 'Cannot remove: member appears in an expense.',
      'group.removeMemberAria': 'Remove {name}',
      'group.totalSpent': 'Total spent:',
      'group.settleUp': 'Settle up',
      'group.addExpense': '+ Add expense',
      'group.newTitle': 'New group',
      'group.nameLabel': 'Group name',
      'group.namePlaceholder': 'e.g. Lisbon Flat',
      'group.currencyLabel': 'Currency',
      'group.membersLabel': 'Members (comma-separated)',
      'group.membersPlaceholder': 'e.g. Nils, Mara, Tomás',
      'group.membersHint': 'List everyone in the group, including yourself.',
      'group.createSubmit': 'Create group',
      'group.nameRequired': 'Group name is required.',
      'group.creating': 'Creating…',
      'group.created': 'Group created',
      'group.createFailed': 'Could not create group.',

      // ---- balances / settlements panels ----
      'panel.balances': 'Balances',
      'panel.suggestedSettlements': 'Suggested settlements',
      'panel.allSettled': 'Everyone is settled up. 🎉',
      'panel.record': 'Record',
      'panel.expenses': 'Expenses',

      // ---- expense row ----
      'expense.paidLine': '{payer} paid {amount}',
      'expense.settlementLine': '{payer} paid {receiver} {amount}',
      'expense.settlementSuffix': 'Settlement',
      'expense.editAria': 'Edit expense',
      'expense.deleteAria': 'Delete expense',
      'expense.deleteSettlementAria': 'Delete settlement',
      'expense.notInvolved': 'Not involved',
      'expense.youLent': 'You lent {amount}',
      'expense.youOwe': 'You owe {amount}',
      'expense.settled': 'Settled',
      'expense.splitHeading': 'Split ({mode})',
      'expense.deletedToast': 'Expense deleted',
      'expense.settlementDeletedToast': 'Settlement deleted',
      'expense.deleteFailed': 'Could not delete.',
      'expense.restored': 'Restored',
      'expense.restoreFailed': 'Could not restore.',

      // ---- split modes ----
      'splitMode.equal': 'Equal',
      'splitMode.exact': 'Exact',
      'splitMode.percent': 'Percent',
      'splitMode.shares': 'Shares',

      // ---- expense modal ----
      'expense.addTitle': 'Add expense',
      'expense.editTitle': 'Edit expense',
      'expense.saveSubmit': 'Save expense',
      'expense.saveChangesSubmit': 'Save changes',
      'expense.descLabel': 'Description',
      'expense.descPlaceholder': 'e.g. Groceries',
      'expense.amountLabel': 'Amount',
      'amount.placeholder': '0.00',
      'expense.paidByLabel': 'Paid by',
      'expense.categoryLabel': 'Category',
      'expense.dateLabel': 'Date',
      'expense.splitLabel': 'Split',
      'expense.participantsLabel': 'Participants',
      'expense.noteLabel': 'Note (optional)',
      'expense.saveFailed': 'Could not save expense.',
      'expense.updatedToast': 'Expense updated',
      'expense.addedToast': 'Expense added',
      'expense.previewHeading': 'Split preview',
      'expense.previewNeedAmount': 'Enter a valid amount to see the split preview.',
      'expense.previewNeedParticipant': 'Select at least one participant.',
      'expense.splitError': 'Unable to compute split.',
      'expense.participantValueAria': '{name} {mode} value',

      // ---- category names (icon baked into the string, same as the
      // original markup) ----
      'category.general': '🧾 General',
      'category.food': '🍔 Food',
      'category.rent': '🏠 Rent',
      'category.transport': '🚗 Transport',
      'category.fun': '🎉 Fun',
      'category.utilities': '💡 Utilities',
      'category.travel': '✈️ Travel',

      // ---- settle-up modal ----
      'settle.fromLabel': 'From',
      'settle.toLabel': 'To',
      'settle.recordSubmit': 'Record settlement',
      'settle.amountInvalid': 'Enter a valid amount.',
      'settle.sameMember': '"From" and "To" must be different members.',
      'settle.recorded': 'Settlement recorded',
      'settle.recordFailed': 'Could not record settlement.',

      // ---- invite modal ----
      'invite.title': 'Invite to group',
      'invite.hint': "Anyone with this code can join and see this group's expenses.",
      'invite.copyLink': 'Copy invite link',
      'invite.copyCode': 'Copy code only',
      'invite.codeCopied': 'Invite code copied',
      'invite.linkCopied': 'Invite link copied — send it to your friend',
      'invite.copyFailed': 'Could not copy — select it and copy manually.',
      'invite.copyManually': 'Copy manually: {text}',
      'invite.noCode': '(no code)',

      // ---- join modal ----
      'join.title': 'Join a group',
      'join.codeLabel': 'Invite code',
      'join.codePlaceholder': 'e.g. AB12CD',
      'join.codeHint': 'Ask a group member for their invite code.',
      'join.submit': 'Join',
      'join.submitting': 'Joining…',
      'join.codeRequired': 'Enter the invite code your friend sent you.',
      'join.joined': 'Joined the group',
      'join.failed': 'Could not join that group.',
      'join.signInFirst': "Sign in to join a friend's group.",

      // ---- prompt / confirm dialog defaults ----
      'modal.renameDefaultTitle': 'Rename',
      'prompt.needValue': 'Please enter a value.',
      'confirm.typeToConfirmDefault': 'Type the name to confirm',
      'confirm.typeToConfirmLabel': 'Type "{text}" to confirm',
      'confirm.mismatch': 'That does not match. Type it exactly to confirm.',

      // ---- data menu / reset / demo ----
      'data.resetTitle': 'Reset all data?',
      'data.resetSubmit': 'Reset everything',
      'data.resetBody': 'This deletes every group and expense stored in this browser. It cannot be undone.',
      'data.resetConfirmWord': 'RESET',
      'data.resetDone': 'All data reset',
      'data.resetRemoteBlocked': 'Reset is only available in demo mode. Delete a group instead.',
      'data.demoRemoteBlocked': 'Demo data is only available in demo mode.',
      'data.demoLoaded': 'Demo data loaded',
      'data.exported': 'Exported data',
      'data.importRemoteBlocked': 'Importing a file is only available in demo mode.',
      'data.imported': 'Data imported',
      'data.importFailed': 'Import failed: invalid file.',
      'data.readFailed': 'Could not read file.',

      // ---- sync status / error banner ----
      'sync.saving': 'Saving…',
      'sync.saved': 'Saved',
      'sync.notSaved': 'Not saved',
      'sync.errorBannerDefault': 'A change could not be saved. It is not stored.',
      'sync.loadGroupsFailedPrefix': 'Could not load your groups: ',
      'sync.unknownError': 'unknown error',
      'sync.serverUnreachable': 'Could not reach the server — starting in demo mode.',

      // ---- auth / sign-in screen ----
      'auth.tagline': 'A shared expense tracker for friends, roommates and trips — split costs fairly and keep track of who owes who.',
      'auth.nameLabel': 'Your name',
      'auth.namePlaceholder': 'e.g. Nils',
      'auth.nameHint': 'This is what your friends will see next to each expense.',
      'auth.emailLabel': 'Email',
      'auth.passwordLabel': 'Password',
      'auth.passwordPlaceholder': 'At least 8 characters',
      'auth.signIn': 'Sign in',
      'auth.createAccount': 'Create account',
      'auth.noAccountYet': 'No account yet?',
      'auth.alreadyHaveAccount': 'Already have an account?',
      'auth.createOne': 'Create one',
      'auth.tryDemo': 'Try the demo without an account',
      'auth.demoHint': 'Demo data stays only in this browser — it is not shared with anyone.',
      'auth.enterEmail': 'Enter your email address.',
      'auth.passwordTooShort': 'Password must be at least 8 characters.',
      'auth.enterName': 'Enter the name your friends will see.',
      'auth.signInFailed': 'Could not sign in.',
      'auth.signOutFailedPrefix': 'Could not sign out: ',
      'auth.demoDataWarning': 'You have {groups} {groupWord} and {expenses} {expenseWord} saved in this browser from demo mode. Creating an account starts a fresh, shared set of books — this demo data stays here and will not move across.',
      'auth.groupLinkUnavailable': 'That group link is not available on this account.',
      'auth.signedInFallback': 'Signed in',

      // ---- misc ----
      'misc.unknownMember': 'Unknown',
      'misc.undo': 'Undo',
      'misc.noGroupSelected': 'No group selected'
    },

    de: {
      // ---- shared/common ----
      'common.cancel': 'Abbrechen',
      'common.close': 'Schließen',
      'common.closeDialog': 'Dialog schließen',
      'common.dismiss': 'Schließen',
      'common.save': 'Speichern',
      'common.delete': 'Löschen',
      'common.value': 'Wert',
      'common.edit': 'Bearbeiten',
      'common.add': 'Hinzufügen',
      'common.name': 'Name',
      'common.areYouSure': 'Bist du sicher?',

      // ---- header ----
      'header.currentUser': 'Aktuelle Person',
      'header.dataMenu': 'Daten ▾',
      'header.export': 'JSON exportieren',
      'header.import': 'JSON importieren…',
      'header.importFileAria': 'JSON-Datei zum Importieren auswählen',
      'header.loadDemo': 'Demodaten laden',
      'header.resetAll': 'Alle Daten zurücksetzen',
      'header.admin': 'Admin',
      'header.signOut': 'Abmelden',

      // ---- sidebar ----
      'sidebar.groups': 'Gruppen',
      'sidebar.newGroup': '+ Neue Gruppe',
      'sidebar.joinWithCode': 'Mit Code beitreten',
      'sidebar.noGroupsYet': 'Noch keine Gruppen.',

      // ---- pluralized units ----
      'unit.expense.one': 'Ausgabe',
      'unit.expense.other': 'Ausgaben',
      'unit.settlement.one': 'Ausgleichszahlung',
      'unit.settlement.other': 'Ausgleichszahlungen',
      'unit.member.one': 'Mitglied',
      'unit.member.other': 'Mitglieder',
      'unit.group.one': 'Gruppe',
      'unit.group.other': 'Gruppen',

      // ---- empty states ----
      'empty.selectGroupTitle': 'Gruppe auswählen',
      'empty.selectGroupBody': 'Wähle eine Gruppe aus der Seitenleiste, um ihre Ausgaben und Salden zu sehen.',
      'empty.noGroupsTitle': 'Noch keine Gruppen',
      'empty.noGroupsBody': 'Erstelle eine Gruppe, um Ausgaben mit Freunden aufzuteilen.',
      'empty.noExpensesTitle': 'Noch keine Ausgaben',
      'empty.noExpensesBody': 'Füge deine erste Ausgabe hinzu, um Kosten aufzuteilen.',

      // ---- group view ----
      'group.rename': 'Gruppe umbenennen',
      'group.renameSubmit': 'Umbenennen',
      'group.renamed': 'Gruppe umbenannt',
      'group.renameFailed': 'Gruppe konnte nicht umbenannt werden.',
      'group.delete': 'Gruppe löschen',
      'group.deleteTitle': 'Diese Gruppe löschen?',
      'group.deleteBody.main': '{name} und ihre {count} {expenseWord} werden endgültig gelöscht.',
      'group.deleteBody.sharedSuffix': ' Das betrifft alle {count} {memberWord}, nicht nur dich.',
      'group.deleteBody.cannotUndo': ' Das kann nicht rückgängig gemacht werden.',
      'group.deleted': 'Gruppe gelöscht',
      'group.deleteFailed': 'Gruppe konnte nicht gelöscht werden.',
      'group.invite': 'Einladen',
      'group.addMember': '+ Mitglied',
      'group.addMemberTitle': 'Mitglied hinzufügen',
      'group.addMemberPlaceholder': 'z. B. Mara',
      'group.addMemberHint': 'Nur im Demomodus — mit einem Konto treten Freunde über einen Einladungscode bei.',
      'group.memberAdded': 'Mitglied hinzugefügt',
      'group.memberAddFailed': 'Mitglied konnte nicht hinzugefügt werden.',
      'group.memberRemoved': 'Mitglied entfernt',
      'group.memberRemoveFailed': 'Entfernen nicht möglich: Mitglied taucht in einer Ausgabe auf.',
      'group.removeMemberAria': '{name} entfernen',
      'group.totalSpent': 'Insgesamt ausgegeben:',
      'group.settleUp': 'Ausgleichen',
      'group.addExpense': '+ Ausgabe hinzufügen',
      'group.newTitle': 'Neue Gruppe',
      'group.nameLabel': 'Gruppenname',
      'group.namePlaceholder': 'z. B. WG Lissabon',
      'group.currencyLabel': 'Währung',
      'group.membersLabel': 'Mitglieder (durch Komma getrennt)',
      'group.membersPlaceholder': 'z. B. Nils, Mara, Tomás',
      'group.membersHint': 'Liste alle in der Gruppe auf, dich eingeschlossen.',
      'group.createSubmit': 'Gruppe erstellen',
      'group.nameRequired': 'Gruppenname ist erforderlich.',
      'group.creating': 'Wird erstellt…',
      'group.created': 'Gruppe erstellt',
      'group.createFailed': 'Gruppe konnte nicht erstellt werden.',

      // ---- balances / settlements panels ----
      'panel.balances': 'Salden',
      'panel.suggestedSettlements': 'Vorgeschlagene Ausgleichszahlungen',
      'panel.allSettled': 'Alle sind ausgeglichen. 🎉',
      'panel.record': 'Erfassen',
      'panel.expenses': 'Ausgaben',

      // ---- expense row ----
      'expense.paidLine': '{payer} hat {amount} bezahlt',
      'expense.settlementLine': '{payer} hat {receiver} {amount} bezahlt',
      'expense.settlementSuffix': 'Ausgleichszahlung',
      'expense.editAria': 'Ausgabe bearbeiten',
      'expense.deleteAria': 'Ausgabe löschen',
      'expense.deleteSettlementAria': 'Ausgleichszahlung löschen',
      'expense.notInvolved': 'Nicht beteiligt',
      'expense.youLent': 'Du hast {amount} ausgelegt',
      'expense.youOwe': 'Du schuldest {amount}',
      'expense.settled': 'Ausgeglichen',
      'expense.splitHeading': 'Aufteilung ({mode})',
      'expense.deletedToast': 'Ausgabe gelöscht',
      'expense.settlementDeletedToast': 'Ausgleichszahlung gelöscht',
      'expense.deleteFailed': 'Löschen fehlgeschlagen.',
      'expense.restored': 'Wiederhergestellt',
      'expense.restoreFailed': 'Wiederherstellen fehlgeschlagen.',

      // ---- split modes ----
      'splitMode.equal': 'Gleich',
      'splitMode.exact': 'Exakt',
      'splitMode.percent': 'Prozent',
      'splitMode.shares': 'Anteile',

      // ---- expense modal ----
      'expense.addTitle': 'Ausgabe hinzufügen',
      'expense.editTitle': 'Ausgabe bearbeiten',
      'expense.saveSubmit': 'Ausgabe speichern',
      'expense.saveChangesSubmit': 'Änderungen speichern',
      'expense.descLabel': 'Beschreibung',
      'expense.descPlaceholder': 'z. B. Einkauf',
      'expense.amountLabel': 'Betrag',
      'amount.placeholder': '0,00',
      'expense.paidByLabel': 'Bezahlt von',
      'expense.categoryLabel': 'Kategorie',
      'expense.dateLabel': 'Datum',
      'expense.splitLabel': 'Aufteilung',
      'expense.participantsLabel': 'Teilnehmer',
      'expense.noteLabel': 'Notiz (optional)',
      'expense.saveFailed': 'Ausgabe konnte nicht gespeichert werden.',
      'expense.updatedToast': 'Ausgabe aktualisiert',
      'expense.addedToast': 'Ausgabe hinzugefügt',
      'expense.previewHeading': 'Aufteilungsvorschau',
      'expense.previewNeedAmount': 'Gib einen gültigen Betrag ein, um die Aufteilungsvorschau zu sehen.',
      'expense.previewNeedParticipant': 'Wähle mindestens eine Person aus.',
      'expense.splitError': 'Aufteilung konnte nicht berechnet werden.',
      'expense.participantValueAria': '{name} – {mode}-Wert',

      // ---- category names ----
      'category.general': '🧾 Sonstiges',
      'category.food': '🍔 Essen',
      'category.rent': '🏠 Miete',
      'category.transport': '🚗 Transport',
      'category.fun': '🎉 Spaß',
      'category.utilities': '💡 Nebenkosten',
      'category.travel': '✈️ Reisen',

      // ---- settle-up modal ----
      'settle.fromLabel': 'Von',
      'settle.toLabel': 'An',
      'settle.recordSubmit': 'Ausgleichszahlung erfassen',
      'settle.amountInvalid': 'Gib einen gültigen Betrag ein.',
      'settle.sameMember': '„Von“ und „An“ müssen unterschiedliche Mitglieder sein.',
      'settle.recorded': 'Ausgleichszahlung erfasst',
      'settle.recordFailed': 'Ausgleichszahlung konnte nicht erfasst werden.',

      // ---- invite modal ----
      'invite.title': 'Zur Gruppe einladen',
      'invite.hint': 'Jeder mit diesem Code kann beitreten und die Ausgaben dieser Gruppe sehen.',
      'invite.copyLink': 'Einladungslink kopieren',
      'invite.copyCode': 'Nur Code kopieren',
      'invite.codeCopied': 'Einladungscode kopiert',
      'invite.linkCopied': 'Einladungslink kopiert — schick ihn deinem Freund',
      'invite.copyFailed': 'Kopieren fehlgeschlagen — markiere ihn und kopiere manuell.',
      'invite.copyManually': 'Manuell kopieren: {text}',
      'invite.noCode': '(kein Code)',

      // ---- join modal ----
      'join.title': 'Einer Gruppe beitreten',
      'join.codeLabel': 'Einladungscode',
      'join.codePlaceholder': 'z. B. AB12CD',
      'join.codeHint': 'Frag ein Gruppenmitglied nach dem Einladungscode.',
      'join.submit': 'Beitreten',
      'join.submitting': 'Trete bei…',
      'join.codeRequired': 'Gib den Einladungscode ein, den du von deinem Freund bekommen hast.',
      'join.joined': 'Der Gruppe beigetreten',
      'join.failed': 'Beitritt zur Gruppe fehlgeschlagen.',
      'join.signInFirst': 'Melde dich an, um der Gruppe eines Freundes beizutreten.',

      // ---- prompt / confirm dialog defaults ----
      'modal.renameDefaultTitle': 'Umbenennen',
      'prompt.needValue': 'Bitte gib einen Wert ein.',
      'confirm.typeToConfirmDefault': 'Gib den Namen ein, um zu bestätigen',
      'confirm.typeToConfirmLabel': 'Gib „{text}“ ein, um zu bestätigen',
      'confirm.mismatch': 'Das stimmt nicht überein. Gib es exakt ein, um zu bestätigen.',

      // ---- data menu / reset / demo ----
      'data.resetTitle': 'Alle Daten zurücksetzen?',
      'data.resetSubmit': 'Alles zurücksetzen',
      'data.resetBody': 'Dadurch werden alle Gruppen und Ausgaben in diesem Browser gelöscht. Das kann nicht rückgängig gemacht werden.',
      'data.resetConfirmWord': 'ZURÜCKSETZEN',
      'data.resetDone': 'Alle Daten zurückgesetzt',
      'data.resetRemoteBlocked': 'Zurücksetzen ist nur im Demomodus möglich. Lösche stattdessen eine Gruppe.',
      'data.demoRemoteBlocked': 'Demodaten sind nur im Demomodus verfügbar.',
      'data.demoLoaded': 'Demodaten geladen',
      'data.exported': 'Daten exportiert',
      'data.importRemoteBlocked': 'Dateiimport ist nur im Demomodus möglich.',
      'data.imported': 'Daten importiert',
      'data.importFailed': 'Import fehlgeschlagen: ungültige Datei.',
      'data.readFailed': 'Datei konnte nicht gelesen werden.',

      // ---- sync status / error banner ----
      'sync.saving': 'Wird gespeichert…',
      'sync.saved': 'Gespeichert',
      'sync.notSaved': 'Nicht gespeichert',
      'sync.errorBannerDefault': 'Eine Änderung konnte nicht gespeichert werden. Sie wurde nicht übernommen.',
      'sync.loadGroupsFailedPrefix': 'Deine Gruppen konnten nicht geladen werden: ',
      'sync.unknownError': 'unbekannter Fehler',
      'sync.serverUnreachable': 'Server nicht erreichbar — Start im Demomodus.',

      // ---- auth / sign-in screen ----
      'auth.tagline': 'Eine gemeinsame Ausgabenverwaltung für Freunde, Mitbewohner und Reisen — teile Kosten fair auf und behalte im Blick, wer wem was schuldet.',
      'auth.nameLabel': 'Dein Name',
      'auth.namePlaceholder': 'z. B. Nils',
      'auth.nameHint': 'Das sehen deine Freunde neben jeder Ausgabe.',
      'auth.emailLabel': 'E-Mail',
      'auth.passwordLabel': 'Passwort',
      'auth.passwordPlaceholder': 'Mindestens 8 Zeichen',
      'auth.signIn': 'Anmelden',
      'auth.createAccount': 'Konto erstellen',
      'auth.noAccountYet': 'Noch kein Konto?',
      'auth.alreadyHaveAccount': 'Schon ein Konto?',
      'auth.createOne': 'Erstellen',
      'auth.tryDemo': 'Demo ohne Konto ausprobieren',
      'auth.demoHint': 'Demodaten bleiben nur in diesem Browser — sie werden mit niemandem geteilt.',
      'auth.enterEmail': 'Gib deine E-Mail-Adresse ein.',
      'auth.passwordTooShort': 'Das Passwort muss mindestens 8 Zeichen lang sein.',
      'auth.enterName': 'Gib den Namen ein, den deine Freunde sehen.',
      'auth.signInFailed': 'Anmeldung fehlgeschlagen.',
      'auth.signOutFailedPrefix': 'Abmeldung fehlgeschlagen: ',
      'auth.demoDataWarning': 'Du hast {groups} {groupWord} und {expenses} {expenseWord} aus dem Demomodus in diesem Browser gespeichert. Ein Konto zu erstellen startet ein neues, gemeinsames Haushaltsbuch — diese Demodaten bleiben hier und werden nicht übernommen.',
      'auth.groupLinkUnavailable': 'Dieser Gruppenlink ist mit diesem Konto nicht verfügbar.',
      'auth.signedInFallback': 'Angemeldet',

      // ---- misc ----
      'misc.unknownMember': 'Unbekannt',
      'misc.undo': 'Rückgängig',
      'misc.noGroupSelected': 'Keine Gruppe ausgewählt'
    }
  };

  var SUPPORTED_LANGS = { en: true, de: true };
  var STORAGE_KEY = 'splitwise.lang.v1';

  // --------------------------------------------------------------------
  // localStorage access - always guarded, exactly like js/store.js does
  // for the app's actual data. Some browsers (private/incognito modes,
  // certain privacy settings) throw just for touching localStorage.
  // --------------------------------------------------------------------
  function loadStoredLang() {
    try {
      if (typeof localStorage === 'undefined') return null;
      var raw = localStorage.getItem(STORAGE_KEY);
      return SUPPORTED_LANGS[raw] ? raw : null;
    } catch (err) {
      return null;
    }
  }

  function persistLang(lang) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (err) {
      // Storage full, disabled, or unavailable - the choice just won't
      // survive a reload. The app keeps working either way.
    }
  }

  function detectInitialLang() {
    var stored = loadStoredLang();
    if (stored) return stored;
    var nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
    return nav.indexOf('de') === 0 ? 'de' : 'en';
  }

  var currentLang = detectInitialLang();
  var listeners = [];

  // --------------------------------------------------------------------
  // t(key, params) - the translation lookup.
  //
  // Looks the key up in the active language; falls back to English if
  // it's missing there; falls back to the raw key (rather than throwing
  // or printing "undefined") if it's missing from English too, so a
  // typo'd key is at least visible instead of breaking the page.
  // --------------------------------------------------------------------
  function rawLookup(lang, key) {
    var dict = DICT[lang];
    return dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
  }

  function t(key, params) {
    var str = rawLookup(currentLang, key);
    if (str === undefined) str = rawLookup('en', key);
    if (str === undefined) str = key;

    if (params) {
      Object.keys(params).forEach(function (name) {
        var value = params[name];
        var replacement = value === null || value === undefined ? '' : String(value);
        // Split/join instead of a regex - simpler to read, and it can't
        // misbehave on placeholder names with regex-special characters.
        str = str.split('{' + name + '}').join(replacement);
      });
    }
    return str;
  }

  function getLang() {
    return currentLang;
  }

  function setLang(lang) {
    if (!SUPPORTED_LANGS[lang] || lang === currentLang) return;
    currentLang = lang;
    persistLang(lang);
    document.documentElement.lang = lang;
    applyStatic(document);
    updateLangSwitches();
    listeners.forEach(function (fn) {
      fn();
    });
  }

  function onChange(fn) {
    listeners.push(fn);
    return function unsubscribe() {
      listeners = listeners.filter(function (l) {
        return l !== fn;
      });
    };
  }

  // --------------------------------------------------------------------
  // applyStatic(root) - translates markup that never changes shape, only
  // text: headings, button labels, hints, placeholders...
  //
  // Two attributes it looks for:
  //   data-i18n="some.key"
  //     Sets the element's textContent to t('some.key'). Only use this on
  //     elements whose whole text content is the translated string (an
  //     icon-only button like "✕" must NOT get this, or the icon gets
  //     wiped) and that no other code ever overwrites afterwards.
  //   data-i18n-attr="attr1:key1;attr2:key2"
  //     Sets one or more attributes instead of textContent - e.g.
  //     data-i18n-attr="placeholder:auth.namePlaceholder" or, for more
  //     than one attribute on the same element,
  //     data-i18n-attr="aria-label:common.close;title:common.close".
  //     Pairs are separated by ";", attribute name and key by the first ":".
  // --------------------------------------------------------------------
  function applyStatic(root) {
    root = root || document;

    qsa('[data-i18n]', root).forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });

    qsa('[data-i18n-attr]', root).forEach(function (el) {
      var spec = el.getAttribute('data-i18n-attr');
      if (!spec) return;
      spec.split(';').forEach(function (pair) {
        pair = pair.trim();
        if (!pair) return;
        var sepIndex = pair.indexOf(':');
        if (sepIndex === -1) return;
        var attrName = pair.slice(0, sepIndex).trim();
        var key = pair.slice(sepIndex + 1).trim();
        if (attrName && key) el.setAttribute(attrName, t(key));
      });
    });
  }

  // --------------------------------------------------------------------
  // The EN/DE toggle. There are two copies of it in the page (header and
  // sign-in screen, see index.html), marked with [data-lang-switch] around
  // a pair of buttons with [data-lang="en"/"de"]. Both get wired here so
  // app.js never has to know this control exists.
  // --------------------------------------------------------------------
  function wireLangSwitches(root) {
    qsa('[data-lang-switch]', root || document).forEach(function (group) {
      qsa('.lang-btn', group).forEach(function (btn) {
        btn.addEventListener('click', function () {
          setLang(btn.getAttribute('data-lang'));
        });
      });
    });
    updateLangSwitches();
  }

  function updateLangSwitches() {
    qsa('.lang-btn').forEach(function (btn) {
      var active = btn.getAttribute('data-lang') === currentLang;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  // ---- boot: set the <html lang>, translate whatever is already in the
  // page, and wire the toggle buttons. Runs immediately (not on
  // DOMContentLoaded) because this script tag sits after all the markup
  // it needs, near the bottom of <body>. ----
  document.documentElement.lang = currentLang;
  applyStatic(document);
  wireLangSwitches(document);

  SW.I18n = {
    t: t,
    getLang: getLang,
    setLang: setLang,
    onChange: onChange,
    applyStatic: applyStatic
  };
})();
