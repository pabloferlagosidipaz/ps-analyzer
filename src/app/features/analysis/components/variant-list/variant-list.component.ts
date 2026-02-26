import { Component, input, output, signal, computed, ChangeDetectionStrategy, effect, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Variant, JobComment } from '../../../../core/models/analysis.model';
import { AnalysisService } from '../../../../core/services/analysis.service';
import { ToastService } from '../../../../core/services/toast.service';
import { ReportService } from '../../../../core/services/report.service';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ask } from '@tauri-apps/plugin-dialog';

/**
 * Component for displaying and filtering a list of genetic variants.
 */
@Component({
    selector: 'app-variant-list',
    standalone: true,
    imports: [CommonModule, FormsModule],
    templateUrl: './variant-list.component.html',
    styleUrl: './variant-list.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class VariantListComponent {
    /** The list of all variants available to display */
    variants = input.required<Variant[]>();
    /** The currently selected variant, if any */
    selectedVariant = input<Variant | null>(null);
    /** Comments associated with variants, keyed by variant identifier */
    comments = input<Record<string, JobComment[]>>({});
    /** The ID of the current analysis job */
    jobId = input<string | null>(null);
    /** Alternative HGVS names returned by VEP */
    hgvsAlternatives = input<Record<string, string[]>>({});

    /** Emitted when a variant is clicked */
    variantClick = output<Variant>();
    /** Emitted when a new comment is added to a variant */
    commentAdded = output<{ variantKey: string, comment: string }>();
    /** Emitted when a comment is deleted */
    commentDeleted = output<{ variantKey: string, commentId: string }>();

    searchTerm = signal<string>('');
    filterType = signal<string>('All');
    filterPatient = signal<string>('All');
    filterConsequence = signal<string>('All');

    filterQuality = signal<string>('All');
    showFilters = signal<boolean>(false);

    // UI State for comments
    expandedComments = signal<Set<string>>(new Set());

    // UI State for HGVS alternatives
    hgvsStates = signal<Map<string, { loading: boolean, error: boolean, alternatives: string[] }>>(new Map());

    newCommentText = signal<Record<string, string>>({});

    private analysisService = inject(AnalysisService);
    private toastService = inject(ToastService);
    private reportService = inject(ReportService);

    constructor() {
        effect(() => {
            // Initialize hgvsStates from input
            const initialMap = new Map<string, { loading: boolean, error: boolean, alternatives: string[] }>();
            const inputAlts = this.hgvsAlternatives();
            if (inputAlts) {
                Object.entries(inputAlts).forEach(([key, alts]) => {
                    initialMap.set(key, { loading: false, error: false, alternatives: alts });
                });
            }
            this.hgvsStates.set(initialMap);

            const qualities = this.availableQualities();
            if (qualities.includes('PASS')) {
                this.filterQuality.set('PASS');
            } else {
                this.filterQuality.set('All');
            }
        });
    }

    /**
     * Copies text to the system clipboard and shows a toast notification.
     */
    async copyToClipboard(text: string, event: Event) {
        event.stopPropagation();
        try {
            await navigator.clipboard.writeText(text);
            this.toastService.show('Copied to clipboard!', 'success');
        } catch (err) {
            console.error('Failed to copy text: ', err);
            this.toastService.show('Failed to copy', 'error');
        }
    }

    /** Computes available variant types for filtering */
    availableTypes = computed(() => {
        const types = new Set(this.variants().map(v => v.type));
        return Array.from(types).sort();
    });

    /** Computes available VEP consequences for filtering */
    availableConsequences = computed(() => {
        const consequences = new Set<string>();
        this.variants().forEach(v => {
            if (v['consequence']) {
                consequences.add(v['consequence']);
            }
        });
        return Array.from(consequences).sort();
    });

    /** Computes available quality values for filtering */
    availableQualities = computed(() => {
        const qualities = new Set<string>();
        this.variants().forEach(v => {
            if (v.filter) {
                qualities.add(v.filter);
            }
        });
        return Array.from(qualities).sort();
    });

    /** Computes available patients for filtering */
    availablePatients = computed(() => {
        const patients = new Set<string>();
        this.variants().forEach(v => {
            patients.add(v.patient);
            if (v.polymorphism) {
                v.polymorphism.forEach((p: Variant) => patients.add(p.patient));
            }
        });
        return Array.from(patients).sort();
    });

    /**
     * Core filtering logic that can be reused for facet counting.
     * @param overrides - Optional filter overrides (e.g. to calculate counts for a different category)
     */
    private applyFilters(overrides: { type?: string, patient?: string, quality?: string, consequence?: string } = {}): Variant[] {
        let list = this.variants();
        const search = this.searchTerm().toLowerCase().trim();
        const typeFilter = (overrides.type ?? this.filterType()).toLowerCase();
        const patientFilter = overrides.patient ?? this.filterPatient();
        const qualityFilter = overrides.quality ?? this.filterQuality();
        const consequenceFilter = overrides.consequence ?? this.filterConsequence();

        // Apply Quality Filter
        if (qualityFilter !== 'All') {
            list = list.filter(v => {
                if (!v.filter) return true;
                return v.filter === qualityFilter;
            });
        }

        // Apply Type Filter
        if (typeFilter !== 'all') {
            list = list.filter(v => v.type.toLowerCase() === typeFilter);
        }

        // Apply Patient Filter
        if (patientFilter !== 'All') {
            list = list.filter(v => {
                if (v.patient === patientFilter) return true;
                if (v.polymorphism) {
                    return v.polymorphism.some((p: Variant) => p.patient === patientFilter);
                }
                return false;
            });
        }

        // Apply Consequence Filter
        if (consequenceFilter !== 'All') {
            list = list.filter(v => v['consequence'] === consequenceFilter);
        }

        // Apply Search Filter
        if (search) {
            list = list.filter(v => {
                const mutation = `${v.ref}${v.position}${v.alt}`.toLowerCase();
                const posStr = v.position.toString();
                const involvedPatients = this.getInvolvedPatients(v).map(p => p.toLowerCase());
                const hgvs = this.getHgvs(v).map(h => h.toLowerCase());

                return mutation.includes(search) ||
                    posStr.includes(search) ||
                    involvedPatients.some(p => p.includes(search)) ||
                    hgvs.some(h => h.includes(search));
            });
        }

        return list;
    }

    /** The actual list of variants to display after all filters are applied */
    filteredVariants = computed(() => this.applyFilters());

    /** Total count of variants visible with current filters */
    totalCount = computed(() => this.filteredVariants().length);

    /** Count of variants for each type, ignoring the current type filter */
    typeCounts = computed(() => {
        const counts: Record<string, number> = {};
        const baseFiltered = this.applyFilters({ type: 'All' });
        baseFiltered.forEach(v => {
            counts[v.type] = (counts[v.type] ?? 0) + 1;
        });
        counts['All'] = baseFiltered.length;
        return counts;
    });

    /** Count of variants for each quality, ignoring the current quality filter */
    qualityCounts = computed(() => {
        const counts: Record<string, number> = {};
        const baseFiltered = this.applyFilters({ quality: 'All' });
        baseFiltered.forEach(v => {
            const q = v.filter || 'N/A';
            counts[q] = (counts[q] ?? 0) + 1;
        });
        counts['All'] = baseFiltered.length;
        return counts;
    });

    /** Count of variants for each patient, ignoring the current patient filter */
    patientCounts = computed(() => {
        const counts: Record<string, number> = {};
        const baseFiltered = this.applyFilters({ patient: 'All' });
        baseFiltered.forEach(v => {
            const patients = this.getInvolvedPatients(v);
            patients.forEach(p => {
                counts[p] = (counts[p] ?? 0) + 1;
            });
        });
        counts['All'] = baseFiltered.length;
        return counts;
    });

    /** Count of variants for each consequence, ignoring the current consequence filter */
    consequenceCounts = computed(() => {
        const counts: Record<string, number> = {};
        const baseFiltered = this.applyFilters({ consequence: 'All' });
        baseFiltered.forEach(v => {
            if (v['consequence']) {
                counts[v['consequence']] = (counts[v['consequence']] ?? 0) + 1;
            }
        });
        counts['All'] = baseFiltered.length;
        return counts;
    });

    updateSearchTerm(term: string) {
        this.searchTerm.set(term);
    }

    setQualityFilter(quality: string) {
        this.filterQuality.set(quality);
    }

    setFilter(type: string) {
        this.filterType.set(type);
    }

    setPatientFilter(patient: string) {
        this.filterPatient.set(patient);
    }

    setConsequenceFilter(consequence: string) {
        this.filterConsequence.set(consequence);
    }

    toggleFilters() {
        this.showFilters.update(v => !v);
    }

    ensureVariantVisible(v: Variant) {
        let needsUpdate = false;
        const search = this.searchTerm().toLowerCase().trim();
        if (search) {
            const mutation = `${v.ref}${v.position}${v.alt}`.toLowerCase();
            const posStr = v.position.toString();
            const involvedPatients = this.getInvolvedPatients(v).map(p => p.toLowerCase());
            const hgvs = this.getHgvs(v).map(h => h.toLowerCase());

            const matchesSearch = mutation.includes(search) ||
                posStr.includes(search) ||
                involvedPatients.some(p => p.includes(search)) ||
                hgvs.some(h => h.includes(search));

            if (!matchesSearch) {
                this.searchTerm.set('');
                needsUpdate = true;
            }
        }

        if (this.filterType() !== 'All' && this.filterType().toLowerCase() !== v.type.toLowerCase()) {
            this.filterType.set('All');
            needsUpdate = true;
        }

        if (this.filterPatient() !== 'All') {
            const patients = this.getInvolvedPatients(v);
            if (!patients.includes(this.filterPatient())) {
                this.filterPatient.set('All');
                needsUpdate = true;
            }
        }

        if (this.filterQuality() !== 'All') {
            if (v.filter && v.filter !== this.filterQuality()) {
                this.filterQuality.set('All');
                needsUpdate = true;
            }
        }

        if (this.filterConsequence() !== 'All' && v['consequence'] !== this.filterConsequence()) {
            this.filterConsequence.set('All');
            needsUpdate = true;
        }

        return needsUpdate;
    }

    onVariantClick(v: Variant) {
        this.variantClick.emit(v);
    }

    toggleReport(v: Variant, event: Event) {
        event.stopPropagation();
        const jId = this.jobId();
        if (!jId) {
            this.toastService.show('Job ID not found', 'error');
            return;
        }
        this.reportService.toggleMark(jId, v.position);
        const newState = this.reportService.isMarked(jId, v.position);
        this.toastService.show(newState ? 'Added to report' : 'Removed from report', 'success');
    }

    isMarkedForReport(v: Variant): boolean {
        const jId = this.jobId();
        if (!jId) return false;
        return this.reportService.isMarked(jId, v.position);
    }

    getHgvsState(v: Variant) {
        return this.hgvsStates().get(this.getHgvsKey(v));
    }

    /**
     * Fetches HGVS alternatives for a variant from the analysis service.
     */
    async fetchHgvsAlternatives(v: Variant, event?: Event) {
        if (event) event.stopPropagation();

        const key = this.getHgvsKey(v);
        const currentHgvs = this.getHgvs(v);

        if (currentHgvs.length > 1) {
            // Already have alternatives
            return;
        }


        if (currentHgvs.length === 0) return;

        const primary = currentHgvs[0];
        const parts = primary.split(':');
        if (parts.length < 2) return;

        const transcript = parts[0];

        this.hgvsStates.update(prev => {
            const next = new Map(prev);
            next.set(key, { loading: true, error: false, alternatives: [] });
            return next;
        });

        try {
            const alternatives = await this.analysisService.getHgvsAlternatives(
                transcript,
                v.position,
                v.ref,
                v.alt
            );

            this.hgvsStates.update(prev => {
                const next = new Map(prev);
                next.set(key, { loading: false, error: false, alternatives });
                return next;
            });
            this.toastService.show('Alternatives received', 'success');

            // Save to job if jobId is present
            const jId = this.jobId();
            if (jId) {
                // The key for storage should be the principal HGVS (primary) as requested by user
                // "save it in an object with the principal HGVS as the key"
                await this.analysisService.addJobHgvsAlternatives(jId, primary, alternatives);
            }

        } catch (err) {
            console.error(err);
            this.hgvsStates.update(prev => {
                const next = new Map(prev);
                next.set(key, { loading: false, error: true, alternatives: [] });
                return next;
            });
        }
    }

    getHgvs(v: Variant): string[] {
        const key = this.getHgvsKey(v);
        const state = this.hgvsStates().get(key);

        if (state && state.alternatives.length > 0) {
            return state.alternatives;
        }

        if (!v['hgvs']) return [];
        if (Array.isArray(v['hgvs'])) return v['hgvs'];
        return [v['hgvs'].toString()];
    }

    async openEnsembl(v: Variant, event: Event) {
        event.stopPropagation();
        const hgvs = this.getHgvs(v);
        if (hgvs.length === 0) return;

        const primary = hgvs[0];
        const query = primary; // Ensembl search works great with HGVS or just accession
        const url = `https://www.ensembl.org/Homo_sapiens/Search/Results?q=${encodeURIComponent(query)}`;

        this.toastService.show('Opening Ensembl page...', 'info');

        try {
            await openUrl(url);
        } catch (err) {
            console.error('Failed to open URL via Tauri opener:', err);
            window.open(url, '_blank');
        }
    }

    getVariantName(v: Variant): string {
        const hgvs = this.getHgvs(v);
        if (hgvs.length > 0) {
            return hgvs[0];
        }
        return `${v.ref}${v.position}${v.alt}`;
    }



    onPillClick(type: string, event: Event) {
        event.stopPropagation();
        this.setFilter(type);
    }

    onQualityClick(quality: string | undefined, event: Event) {
        event.stopPropagation();
        this.setQualityFilter(quality || 'All');
    }

    getQualityColor(qual: number): string {
        const hue = (qual / 100) * 120;
        return `hsl(${hue}, 70%, 45%)`;
    }

    onPatientClick(patient: string, event: Event) {
        event.stopPropagation();
        this.setPatientFilter(patient);
    }

    onConsequenceClick(consequence: string, event: Event) {
        event.stopPropagation();
        this.setConsequenceFilter(consequence);
    }

    getInvolvedPatients(v: Variant): string[] {
        const patients = new Set<string>();
        patients.add(v.patient);
        if (v.polymorphism) {
            v.polymorphism.forEach((p: Variant) => patients.add(p.patient));
        }
        return Array.from(patients).sort();
    }

    getCommentKey(v: Variant): string {
        return v.position.toString();
    }

    getHgvsKey(v: Variant): string {
        // Use HGVS string as key if available, otherwise fallback to position
        // The backend stores alternatives keyed by the principal HGVS string.
        if (v['hgvs']) {
            if (Array.isArray(v['hgvs'])) {
                if (v['hgvs'].length > 0) return v['hgvs'][0].toString();
            } else if (typeof v['hgvs'] === 'string' && v['hgvs'].trim() !== '') {
                return v['hgvs'].toString();
            }
        }
        return v.position.toString();
    }

    toggleComments(variantKey: string, event: Event) {
        event.stopPropagation();
        this.expandedComments.update(prev => {
            const next = new Set(prev);
            if (next.has(variantKey)) {
                next.delete(variantKey);
            } else {
                next.add(variantKey);
            }
            return next;
        });
    }

    updateNewCommentText(variantKey: string, text: string) {
        this.newCommentText.update(prev => ({
            ...prev,
            [variantKey]: text
        }));
    }

    submitComment(variantKey: string, event: Event) {
        event.stopPropagation();
        const text = this.newCommentText()[variantKey];
        if (text && text.trim()) {
            this.commentAdded.emit({
                variantKey,
                comment: text.trim()
            });
            this.updateNewCommentText(variantKey, '');
        }
    }

    async onDeleteComment(variantKey: string, commentId: string, event: Event) {
        event.stopPropagation();
        const confirmed = await ask('Are you sure you want to delete this comment?', {
            title: 'Confirm Deletion',
            kind: 'warning',
        });

        if (confirmed) {
            this.commentDeleted.emit({
                variantKey,
                commentId
            });
        }
    }
}
