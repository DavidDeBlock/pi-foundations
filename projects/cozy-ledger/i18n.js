// =====================================================================
// i18n.js — Dutch strings for the Cozy Ledger app
//
// Single-language (Dutch) translation table. Code identifiers, comments,
// console messages, and DOM-rendered values that come from data
// (category names, descriptions, etc.) stay English by design.
//
// Usage:
//   const { t } = window.i18n;
//   const label = t('nav.dashboard');           // 'Overzicht'
//
// Missing keys fall through to the key string itself so untranslated
// surfaces are visible during development. No English fallback path —
// once a key exists, only the Dutch value ships.
// =====================================================================

const Strings = {
  nl: {
    // ---- Brand / shell -----------------------------------------------
    'brand.name':          'Cozy Ledger',
    'brand.tagline':       'Ons huishoudboekje',
    'sidebar.label.overview': 'Overzicht',
    'sidebar.label.manage':   'Beheren',
    'sidebar.label.backup':   'Back-up',
    'sidebar.foot.title':     'Fase 1',
    'sidebar.foot.body':      'Handmatig bijhouden. In fase 2 komen terugkerende items, budgetten, CSV-import/export en een maandelijks PDF-rapport.',
    'fab.title':              'Transactie toevoegen',
    'topbar.import.title':    'ING België CSV importeren',

    // ---- Nav items ---------------------------------------------------
    'nav.dashboard':    'Overzicht',
    'nav.trends':       'Trends',
    'nav.transactions': 'Transacties',
    'nav.categories':   'Categorieën',
    'nav.sources':      'Rekeningen',
    'nav.users':        'Personen',
    'nav.payees':       'Tegenpartijen',
    'nav.settings':     'Instellingen',

    // ---- Page titles / subs ------------------------------------------
    'page.dashboard.title':    'Ons <em>overzicht</em>',
    'page.dashboard.sub':      'Waar het geld deze maand naartoe ging.',
    'page.trends.title':       'Geld<em>trends</em>',
    'page.trends.sub':         'Meer maanden: saldo, inkomsten vs uitgaven, topcategorieën.',
    'page.transactions.title': 'Alle <em>transacties</em>',
    'page.transactions.sub':   'Filter, zoek, bewerk en bekijk alles.',
    'page.categories.title':   '<em>Categorieën</em>',
    'page.categories.sub':     'Geef elke euro een duidelijke plek.',
    'page.sources.title':      'Rekeningen & <em>wallet</em>',
    'page.sources.sub':        'Bankrekeningen, cash en spaargeld.',
    'page.users.title':        '<em>Personen</em>',
    'page.users.sub':          'De mensen die dit boekje delen.',
    'page.payees.title':       '<em>Tegenpartijen</em>',
    'page.payees.sub':         'Iedereen aan wie je betaalde — gesorteerd op wat nog een categorie nodig heeft.',
    'page.settings.title':     '<em>Instellingen</em>',
    'page.settings.sub':       'Maak een back-up of verhuis je data naar een ander toestel.',

    // ---- Scope selector ---------------------------------------------
    'scope.private.label': 'Privé',
    'scope.private.title': 'Enkel je eigen rekeningen',
    'scope.shared.label':  'Gedeeld',
    'scope.shared.title':  'Enkel huishoud- / gedeelde rekeningen',
    'scope.all.label':     'Alles',
    'scope.all.title':     'Alle rekeningen',

    // ---- Topbar buttons ----------------------------------------------
    'topbar.import':       'Importeren',
    'topbar.add':          'Transactie toevoegen',
    'month.prev':          'Vorige maand',
    'month.next':          'Volgende maand',

    // ---- Dashboard ---------------------------------------------------
    'dashboard.card.income.label':    'Inkomsten',
    'dashboard.card.income.entries':  '{n} boekingen',
    'dashboard.card.expense.label':   'Uitgaven',
    'dashboard.card.expense.entries': '{n} boekingen',
    'dashboard.card.balance.label':   'Saldo',
    'dashboard.card.balance.pos':     'Deze maand gespaard',
    'dashboard.card.balance.neg':     'Meer uitgegeven dan verdiend',
    'dashboard.card.balance.zero':    'Precies in evenwicht',
    'dashboard.card.shared.label':    'Gedeeld / Privé',
    'dashboard.card.shared.foot':     'Gedeelde vs privé-uitgaven',
    'dashboard.donut.title':          'Uitgavenverdeling',
    'dashboard.donut.empty.title':    'Nog niets om te tonen',
    'dashboard.donut.empty.msg':      'Log een paar uitgaven om het beeld te zien.',
    'dashboard.donut.center.total':   'Totaal',
    'dashboard.recent.title':         'Recente transacties',
    'dashboard.recent.viewAll':       'Toon alles →',
    'dashboard.recent.empty.title':   'Geen transacties deze maand',
    'dashboard.recent.empty.msg':     'Druk op + om je eerste toe te voegen.',
    'dashboard.top.title':            'Topcategorieën deze maand',
    'dashboard.top.empty.title':      'Nog geen uitgaven',
    'dashboard.top.empty.msg':        'Eens je er één logt, verschijnt die hier.',
    'dashboard.byGroup.toggle':       'Toon per groep',

    // ---- Trends / charts --------------------------------------------
    'trends.section.flow.title':       'Inkomsten vs uitgaven per maand',
    'trends.section.flow.sub':         'groen = die maand gespaard, rood = meer uitgegeven dan verdiend',
    'trends.section.traj.title.src':   'Saldotraject per rekening',
    'trends.section.traj.sub.src':     'wandelt terug vanaf het getyptte saldo — lijn boven vandaag = méér gehad',
    'trends.section.traj.title.nw':    'Nettowaardetraject',
    'trends.section.traj.sub.nw':      'wandelt terug vanaf de som van je getyptte saldi — zie of je vroeger méér had',
    'trends.tooltip.saved':            'gespaard',
    'trends.tooltip.spent':            'uitgegeven',
    'trends.tooltip.in':               'in',
    'trends.tooltip.out':              'uit',
    'trends.range.1y':                 '1 jaar',
    'trends.range.2y':                 '2 jaar',
    'trends.range.3y':                 '3 jaar',
    'trends.range.all':                'Alles',
    'trends.toggle.sources':           'Per rekening',
    'trends.toggle.networth':          'Nettowaarde',
    'trends.balance.heading':          'Saldoverloop',
    'trends.balance.sub':              'Typ je huidige banksaldo per rekening. De geschiedenis wandelt van daar terug.',
    'trends.balance.empty':            'Geen rekeningen in dit bereik. Wijzig het bereik of voeg een rekening toe.',
    'trends.balance.noActivity':       'Nog geen transacties. Log er een paar en je ziet welke maanden groen (gespaard) of rood (tegenover inkomsten) waren.',
    'trends.balance.noSources':        'Geen rekeningen om te tonen. Voeg een rekening toe of schakel er een in om je saldotraject te zien.',
    'trends.balance.noTxns12':         'Geen transacties in de laatste 12 maanden. Log er een paar om je saldotraject te zien.',
    'trends.balance.saved':            '✓ bewaard',
    'trends.balance.today':            'vandaag',

    // ---- Transactions list ------------------------------------------
    'txn.empty.title':                 'Niets matcht je filters',
    'txn.empty.msg':                   'Wis er een paar of voeg een nieuwe transactie toe.',
    'txn.th.date':                     'Datum',
    'txn.th.desc':                     'Omschrijving',
    'txn.th.category':                 'Categorie',
    'txn.th.userSource':               'Persoon / Rekening',
    'txn.th.scope':                    'Bereik',
    'txn.th.amount':                   'Bedrag',
    'txn.th.actions':                  '',
    'txn.edit.title':                  'Bewerken',
    'txn.delete.title':                'Verwijderen',
    'txn.scope.private':               'Privé',
    'txn.scope.shared':                'Gedeeld',

    // ---- Filters ----------------------------------------------------
    'filter.month':        'Maand',
    'filter.month.all':    'Alle maanden',
    'filter.type':         'Type',
    'filter.type.all':     'Alle types',
    'filter.type.income':  'Inkomsten',
    'filter.type.expense': 'Uitgaven',
    'filter.category':     'Categorie',
    'filter.category.all': 'Alle categorieën',
    'filter.user':         'Persoon',
    'filter.user.all':     'Alle personen',
    'filter.source':       'Rekening',
    'filter.source.all':   'Alle rekeningen',
    'filter.scope':        'Bereik',
    'filter.scope.all':    'Alle bereiken',
    'filter.scope.priv':   'Privé',
    'filter.scope.shared': 'Gedeeld',
    'filter.payee':        'Tegenpartij',
    'filter.payee.all':    'Alle tegenpartijen',
    'filter.group':        'Groep',
    'filter.group.all':    'Alle groepen',
    'filter.group.none':   'Geen groep',
    'filter.reset':        'Herstel',

    // ---- Categories page --------------------------------------------
    'cat.section.manage':          'Beheren',
    'cat.add':                     'Categorie toevoegen',
    'cat.section.expense.title':   'Uitgavencategorieën',
    'cat.section.income.title':    'Inkomstencategorieën',
    'cat.section.expense.empty.title': 'Nog geen uitgavencategorieën',
    'cat.section.expense.empty.msg':   'Voeg er één toe om transacties te markeren.',
    'cat.section.income.empty.title':  'Nog geen inkomstencategorieën',
    'cat.section.income.empty.msg':    'Voeg er één toe om inkomsten te markeren.',
    'cat.active':                  'actief',
    'cat.total':                   'totaal',
    'cat.inactive':                'inactief',
    'cat.card.inactive':           'inactief',

    // ---- Groepen (categories page) ----------------------------------
    'grp.section.title':           'Groepen',
    'grp.section.sub':             'Dialect bovenop categorieën voor overzichten en filters.',
    'grp.empty.title':             'Nog geen groepen',
    'grp.empty.msg':               'Voeg er één toe om categorieën te bundelen.',
    'grp.add':                     'Groep toevoegen',
    'grp.edit.title':              'Bewerken',
    'grp.delete.title':            'Verwijderen',
    'grp.delete.inUse':            'Deze groep wordt nog gebruikt door {n} {cat} en kan niet worden verwijderd.',
    'grp.uncategorized':           'Overige categorieën',

    // ---- Sources page -----------------------------------------------
    'src.section.manage':          'Beheren',
    'src.add':                     'Rekening toevoegen',
    'src.card.title':              'Wallets & rekeningen',
    'src.empty.title':             'Nog geen rekeningen',
    'src.empty.msg':               'Voeg een bankrekening, cash of spaarpotje toe om te starten.',
    'src.meta.shared':             'gedeeld',

    // ---- Users page -------------------------------------------------
    'usr.section.manage':          'Beheren',
    'usr.add':                     'Persoon toevoegen',
    'usr.card.title':              'Personen in dit boekje',
    'usr.empty.title':             'Nog geen personen',
    'usr.empty.msg':               'Voeg minstens één persoon toe om transacties te loggen.',

    // ---- Payees page ------------------------------------------------
    'payee.card.distinct':         'Unieke tegenpartijen',
    'payee.card.distinct.foot':    'Na het uittrekken van merknamen uit omschrijvingen',
    'payee.card.needs':            'Heeft categorie nodig',
    'payee.card.needs.foot.has':   'Klik op een tegenpartij om hun transacties te zien',
    'payee.card.needs.foot.none':  'Alle tegenpartijen zijn gecategoriseerd',
    'payee.empty.title':           'Nog geen tegenpartijen',
    'payee.empty.msg':             'Importeer een afrekening of voeg een transactie toe.',
    'payee.th.payee':              'Tegenpartij',
    'payee.th.count':              'Transacties',
    'payee.th.needCat':            'Categorie nodig',
    'payee.th.lastCat':            'Laatste categorie',
    'payee.th.lastSeen':           'Laatst gezien',
    'payee.th.bulk':               'Categorie instellen voor alle',
    'payee.bulk.pick':             '— kies —',
    'payee.opt.expense':           'Uitgaven',
    'payee.opt.income':            'Inkomsten',

    // ---- Common form labels -----------------------------------------
    'form.type':             'Type',
    'form.type.expense':     'Uitgave',
    'form.type.income':      'Inkomst',
    'form.amount':           'Bedrag',
    'form.date':             'Datum',
    'form.category':         'Categorie',
    'form.description':      'Omschrijving',
    'form.descPlaceholder':  'bijv. Boodschappen',
    'form.paidBy':           'Betaald door',
    'form.source':           'Rekening',
    'form.scope':            'Bereik',
    'form.notes':            'Notities (optioneel)',
    'form.notesPh':          'Iets dat het onthouden waard is',
    'form.name':             'Naam',
    'form.name.ph.cat':      'bijv. Boodschappen',
    'form.name.ph.src':      'bijv. Gezamenlijke rekening',
    'form.name.ph.usr':      'bijv. David',
    'form.color':            'Kleur',
    'form.icon':             'Icoon',
    'form.icons':            'Snelle iconen',
    'form.active':           'Actief',
    'form.inactive':         'Inactief',
    'form.active.catHelp':   'Inactieve categorieën worden verborgen in keuzelijsten.',
    'form.active.srcHelp':   'Inactieve rekeningen worden verborgen in keuzelijsten.',
    'form.active.usrHelp':   'Inactieve personen worden verborgen in keuzelijsten.',
    'form.owner':            'Eigenaar (optioneel)',
    'form.owner.none':       '— Gedeeld / geen —',
    'form.group':            'Groep',
    'form.group.none':       'Geen groep',
    'form.order':            'Volgorde',
    'form.bank':             'Bankrekening',
    'form.cash':             'Cash',
    'form.savings':          'Spaargeld',
    'form.other':            'Overig',

    // ---- Apply-all checkbox (ISSUE-005) -----------------------------
    'applyAll.title':         'Deze categorie toepassen op elke transactie van dezelfde tegenpartij, en onthouden voor toekomstige imports',
    'applyAll.template':      'Ook toepassen op alle <strong>{n}</strong> andere transactie{s} van <span class="payee-name">&ldquo;{name}&rdquo;</span>',

    // ---- Modal buttons ----------------------------------------------
    'btn.cancel':             'Annuleren',
    'btn.save':               'Bewaren',
    'btn.saveChanges':        'Bewaren',
    'btn.add':                'Toevoegen',
    'btn.delete':             'Verwijderen',
    'btn.edit':               'Bewerken',
    'btn.import':             'Importeren',
    'btn.export':             'Exporteren',
    'btn.replace':            'Huidige data vervangen',
    'btn.close':              'Sluiten',

    // ---- Modal titles -----------------------------------------------
    'modal.txn.add':          'Transactie toevoegen',
    'modal.txn.edit':         'Transactie bewerken',
    'modal.cat.add':          'Nieuwe categorie',
    'modal.cat.edit':         'Categorie bewerken',
    'modal.src.add':          'Nieuwe rekening',
    'modal.src.edit':         'Rekening bewerken',
    'modal.usr.add':          'Nieuwe persoon',
    'modal.usr.edit':         'Persoon bewerken',
    'modal.grp.add':          'Nieuwe groep',
    'modal.grp.edit':         'Groep bewerken',
    'modal.import':           'Importeren uit CSV',
    'modal.import.title':     'CSV importeren',

    // ---- Delete confirmations ---------------------------------------
    'confirm.txn':            'Deze transactie verwijderen? Dit kan niet ongedaan gemaakt worden.',
    'confirm.cat':            'Categorie "{name}" verwijderen?',
    'confirm.src':            'Rekening "{name}" verwijderen?',
    'confirm.usr':            'Persoon "{name}" verwijderen?',
    'confirm.grp':            'Groep "{name}" verwijderen? Categorieën in deze groep verliezen hun groepskoppeling.',

    // ---- Validation toasts ------------------------------------------
    'toast.amountRequired':   'Gelieve een positief bedrag in te geven.',
    'toast.dateRequired':     'Gelieve een datum te kiezen.',
    'toast.catRequired':      'Gelieve een categorie te kiezen.',
    'toast.userRequired':     'Gelieve te kiezen wie betaald heeft.',
    'toast.sourceRequired':   'Gelieve een rekening te kiezen.',
    'toast.nameRequired':     'Gelieve een naam in te geven.',
    'toast.catInUse':         'Kan niet verwijderen: deze categorie wordt gebruikt door transacties.',
    'toast.srcInUse':         'Kan niet verwijderen: deze rekening wordt gebruikt door transacties.',
    'toast.usrInUse':         'Kan niet verwijderen: deze persoon wordt gebruikt door transacties.',

    // ---- Success toasts ---------------------------------------------
    'toast.txn.added':        'Transactie toegevoegd',
    'toast.txn.updated':      'Transactie bijgewerkt',
    'toast.txn.deleted':      'Transactie verwijderd',
    'toast.cat.added':        'Categorie toegevoegd',
    'toast.cat.updated':      'Categorie bijgewerkt',
    'toast.cat.deleted':      'Categorie verwijderd',
    'toast.src.added':        'Rekening toegevoegd',
    'toast.src.updated':      'Rekening bijgewerkt',
    'toast.src.deleted':      'Rekening verwijderd',
    'toast.usr.added':        'Persoon toegevoegd',
    'toast.usr.updated':      'Persoon bijgewerkt',
    'toast.usr.deleted':      'Persoon verwijderd',
    'toast.grp.added':        'Groep toegevoegd',
    'toast.grp.updated':      'Groep bijgewerkt',
    'toast.grp.deleted':      'Groep verwijderd',
    'toast.payeeSet':         'Categorie ingesteld voor {n} transactie{s}',
    'toast.imported':         '{n} transactie{s} geïmporteerd',

    // ---- CSV import --------------------------------------------------
    'csv.file':               'CSV-bestand (formaat ING België)',
    'csv.file.hint':          'Kies een afrekeningsbestand. Kopregel vereist.',
    'csv.defaults.user':      'Betaald door (standaard)',
    'csv.defaults.source':    'Rekening (standaard)',
    'csv.defaults.scope':     'Bereik (standaard)',
    'csv.th.date':            'Datum',
    'csv.th.desc':            'Omschrijving',
    'csv.th.amount':          'Bedrag',
    'csv.th.type':            'Type',
    'csv.th.category':        'Categorie',
    'csv.pill.import':        '{n} om te importeren',
    'csv.pill.dupe':          '{n} duplicaten overgeslagen',
    'csv.pill.skip':          '{n} info / nul overgeslagen',
    'csv.th.type.income':     '⬇ Inkomst',
    'csv.th.type.expense':    '⬆ Uitgave',
    'csv.th.type.skip':       '— overslaan —',
    'csv.th.type.unset':      '—',
    'csv.autoMapped':         'auto',
    'csv.autoMapped.title':   'Automatisch ingevuld vanuit bewaarde tegenpartij-koppeling',
    'csv.btn.importN':        '{n} transactie{s} importeren',
    'csv.btn.import0':        '0 transacties importeren',
    'csv.err.noRows':         'Geen rijen gevonden — is dit een ING België CSV?',
    'csv.err.read':           'Bestand kon niet gelezen worden.',

    // ---- Settings page (ISSUE-006) ----------------------------------
    'settings.backup.title':     'Back-up & herstel',
    'settings.backup.sub':       'Neem een momentopname of verhuis je data.',
    'settings.export.json':      'Exporteren → JSON (volledige back-up)',
    'settings.export.json.hint': 'Alle personen, rekeningen, categorieën en transacties — round-trippable.',
    'settings.export.csv':       'Exporteren → CSV (voor Excel)',
    'settings.export.csv.hint':  'Enkel transacties, met namen opgelost. Eén rij per record, gesorteerd op datum.',
    'settings.import.json':      'Importeren vanuit JSON-back-up',
    'settings.import.json.hint': 'Vervangt de huidige data. Eerst wordt een veiligheidskopie in localStorage bewaard.',
    'settings.btn.exportJson':   'JSON exporteren',
    'settings.btn.exportCsv':    'CSV exporteren',
    'settings.btn.importJson':   'JSON importeren',
    'settings.import.title':     'Back-up importeren?',
    'settings.import.summary':   'Deze back-up bevat <strong>{n}</strong>.',
    'settings.import.meta':      'Geëxporteerd op {date} · schemaVersion {ver}',
    'settings.import.warn':      'Dit zal ALLE huidige data VERVANGEN.',
    'settings.import.warn2':     'Eerst wordt een veiligheidskopie in localStorage bewaard.',
    'settings.import.done':      '{n} transacties geïmporteerd.',
    'settings.import.err.parse': 'Back-upbestand is geen geldige JSON.',
    'settings.import.err.scheme':'Back-up schemaVersion {ver} wordt niet ondersteund door deze app-versie (verwacht 1).',
    'settings.import.err.noState':'Back-up mist de "state"-sleutel.',
    'settings.import.err.noSchema':'Back-up mist schemaVersion.',
  },
};

// Resolve a single key. Falls through to the key string when missing so
// untranslated surfaces are visible during development. No English
// fallback path — once a key exists, only the Dutch value ships.
function t(key, params) {
  const dict = Strings.nl || {};
  let s = dict[key];
  if (s == null) return key;
  if (params && typeof s === 'string') {
    for (const [k, v] of Object.entries(params)) {
      // {k} and {k} substitutes; {s} is the special plural marker.
      s = s.split('{' + k + '}').join(String(v));
    }
    // Plural helper: pick the right Dutch plural suffix based on the
    // letter immediately preceding the {s} marker. Vowels take 's'
    // (transactie → transacties), consonants take 'en' (boek → boeken).
    if (params.n != null) {
      s = s.replace(/(\w)\{s\}/g, (_, prev) => prev + (params.n === 1 ? '' : /[aeiouy]/i.test(prev) ? 's' : 'en'));
      // {en} is the explicit Dutch plural marker — it expands to 'en'
      // when the count != 1, else the empty string.
      s = s.split('{en}').join(params.n === 1 ? '' : 'en');
    } else {
      s = s.split('{s}').join('');
      s = s.split('{en}').join('');
    }
  }
  return s;
}

// Expose on window so the test harness can introspect the table.
window.Strings = Strings;
window.t = t;
window.i18n = { t, Strings };