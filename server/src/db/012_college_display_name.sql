-- QUAD — migration 012: the college's display name, as it is written.
UPDATE campus_site SET college_name = 'UPES — University of Petroleum and Energy Studies', updated_at = now()
 WHERE slug IN ('upes-bidholi', 'upes-kandholi')
   AND college_name = 'UPES - University of Petroleum and Energy Studies';
